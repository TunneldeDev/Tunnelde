use super::*;
use russh::{
    keys::HashAlg,
    server::{self, Server as _, Session},
    ChannelId,
};
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc,
};
use tokio::{sync::Mutex, task::JoinHandle};

#[derive(Default)]
struct Observation {
    hold_open: AtomicBool,
    pending: Mutex<Option<server::ChannelOpenHandle>>,
    opened: tokio::sync::Notify,
    executed: tokio::sync::Notify,
    commands: AtomicUsize,
    bytes: AtomicUsize,
    closed: AtomicUsize,
}

#[derive(Clone)]
struct Server {
    observation: Arc<Observation>,
    stall: bool,
}
impl server::Server for Server {
    type Handler = Self;
    fn new_client(&mut self, _: Option<std::net::SocketAddr>) -> Self {
        self.clone()
    }
}
impl server::Handler for Server {
    type Error = russh::Error;
    async fn auth_none(&mut self, _: &str) -> Result<server::Auth, Self::Error> {
        Ok(server::Auth::Accept)
    }
    async fn channel_open_session(
        &mut self,
        _: Channel<server::Msg>,
        reply: server::ChannelOpenHandle,
        _: &mut Session,
    ) -> Result<(), Self::Error> {
        if self.observation.hold_open.swap(false, Ordering::SeqCst) {
            *self.observation.pending.lock().await = Some(reply);
        } else {
            reply.accept().await;
        }
        self.observation.opened.notify_one();
        Ok(())
    }
    async fn exec_request(
        &mut self,
        id: ChannelId,
        command: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        assert_eq!(command, b"owned-helper send");
        self.observation.commands.fetch_add(1, Ordering::SeqCst);
        self.observation.executed.notify_one();
        session.channel_success(id)?;
        Ok(())
    }
    async fn data(
        &mut self,
        _: ChannelId,
        data: &[u8],
        _: &mut Session,
    ) -> Result<(), Self::Error> {
        self.observation
            .bytes
            .fetch_add(data.len(), Ordering::SeqCst);
        Ok(())
    }
    async fn channel_eof(
        &mut self,
        id: ChannelId,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        if !self.stall {
            session.data(id, b"{\"ok\":true}".as_slice())?;
            session.extended_data(id, 1, b"diagnostic".as_slice())?;
            session.exit_status_request(id, 0)?;
            session.eof(id)?;
            session.close(id)?;
        }
        Ok(())
    }
    async fn channel_close(&mut self, _: ChannelId, _: &mut Session) -> Result<(), Self::Error> {
        self.observation.closed.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

struct Client(String);
impl client::Handler for Client {
    type Error = russh::Error;
    async fn check_server_key(
        &mut self,
        key: &russh::keys::PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        Ok(key.public_key().fingerprint(HashAlg::Sha256).to_string() == self.0)
    }
}
struct Fixture {
    handle: Arc<client::Handle<Client>>,
    observation: Arc<Observation>,
    server: JoinHandle<()>,
}
impl Fixture {
    async fn start(hold_open: bool, stall: bool) -> Self {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let address = listener.local_addr().unwrap();
        let key =
            russh::keys::PrivateKey::random(&mut rand::rng(), russh::keys::Algorithm::Ed25519)
                .unwrap();
        let fingerprint = key.public_key().fingerprint(HashAlg::Sha256).to_string();
        let observation = Arc::new(Observation::default());
        observation.hold_open.store(hold_open, Ordering::SeqCst);
        let mut server = Server {
            observation: observation.clone(),
            stall,
        };
        let config = Arc::new(server::Config {
            keys: vec![key],
            ..Default::default()
        });
        let server =
            tokio::spawn(async move { server.run_on_socket(config, &listener).await.unwrap() });
        let mut handle = client::connect(
            Arc::new(client::Config::default()),
            address,
            Client(fingerprint),
        )
        .await
        .unwrap();
        assert!(handle
            .authenticate_none("runner-dispatch-test")
            .await
            .unwrap()
            .success());
        Self {
            handle: Arc::new(handle),
            observation,
            server,
        }
    }
    async fn exchange(
        &self,
        limits: Limits,
        current: impl Fn() -> AppResult<()>,
    ) -> Result<Output, Failure> {
        let handle = self.handle.clone();
        exchange(
            async move {
                handle
                    .channel_open_session()
                    .await
                    .map_err(|e| AppError::Ssh(e.to_string()))
            },
            "owned-helper send".into(),
            Some("isolated-prompt".into()),
            limits,
            current,
        )
        .await
    }
    async fn closed(&self) {
        tokio::time::timeout(Duration::from_secs(3), async {
            while self.observation.closed.load(Ordering::SeqCst) == 0 {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("rejected exchange did not close its SSH channel");
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.server.abort();
    }
}
fn limits() -> Limits {
    Limits {
        timeout: Duration::from_secs(3),
        output: 4096,
    }
}
fn rejected(result: Result<Output, Failure>) {
    match result {
        Err(Failure::Connection(error)) => {
            assert_eq!(error.to_string(), "plugin.runners.recordChanged")
        }
        _ => panic!("expected rejection of the original dispatch authority"),
    }
}

#[tokio::test]
async fn stale_request_never_opens_a_channel() {
    let result = exchange(
        async { panic!("stale operation polled channel-open future") },
        "owned-helper send".into(),
        Some("must not send".into()),
        limits(),
        || Err(AppError::validation("plugin.runners.recordChanged")),
    )
    .await;
    rejected(result);
}

#[tokio::test]
async fn stop_during_channel_open_prevents_command_and_input_and_parent_stays_usable() {
    let fixture = Fixture::start(true, false).await;
    let current = AtomicBool::new(true);
    let sending = fixture.exchange(limits(), || {
        if current.load(Ordering::SeqCst) {
            Ok(())
        } else {
            Err(AppError::validation("plugin.runners.recordChanged"))
        }
    });
    let stop = async {
        tokio::time::timeout(
            Duration::from_secs(3),
            fixture.observation.opened.notified(),
        )
        .await
        .unwrap();
        current.store(false, Ordering::SeqCst);
        fixture
            .observation
            .pending
            .lock()
            .await
            .take()
            .unwrap()
            .accept()
            .await;
    };
    let (result, ()) = tokio::join!(sending, stop);
    rejected(result);
    fixture.closed().await;
    assert_eq!(fixture.observation.commands.load(Ordering::SeqCst), 0);
    assert_eq!(fixture.observation.bytes.load(Ordering::SeqCst), 0);
    assert!(fixture.exchange(limits(), || Ok(())).await.is_ok());
    assert_eq!(fixture.observation.commands.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn invalidation_at_payload_boundary_never_sends_prompt_or_initialization() {
    let fixture = Fixture::start(false, false).await;
    let checks = AtomicUsize::new(0);
    let result = fixture
        .exchange(limits(), || {
            if checks.fetch_add(1, Ordering::SeqCst) < 2 {
                Ok(())
            } else {
                Err(AppError::validation("plugin.runners.recordChanged"))
            }
        })
        .await;
    rejected(result);
    fixture.closed().await;
    assert_eq!(checks.load(Ordering::SeqCst), 3);
    assert_eq!(fixture.observation.commands.load(Ordering::SeqCst), 1);
    assert_eq!(fixture.observation.bytes.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn accepted_exchange_retains_output_stderr_exit_and_sends_input_once() {
    let fixture = Fixture::start(false, false).await;
    let result = match fixture.exchange(limits(), || Ok(())).await {
        Ok(output) => output,
        Err(_) => panic!("current operation failed"),
    };
    assert_eq!(result.stdout, b"{\"ok\":true}");
    assert_eq!(result.stderr, b"diagnostic");
    assert_eq!(result.code, Some(0));
    assert_eq!(fixture.observation.commands.load(Ordering::SeqCst), 1);
    assert_eq!(
        fixture.observation.bytes.load(Ordering::SeqCst),
        "isolated-prompt".len()
    );
}

#[tokio::test]
async fn output_budget_and_deadline_still_close_the_owned_exchange() {
    let fixture = Fixture::start(false, false).await;
    assert!(matches!(
        fixture
            .exchange(
                Limits {
                    output: 4,
                    ..limits()
                },
                || Ok(())
            )
            .await,
        Err(Failure::OutputTooLarge)
    ));
    let stalled = Fixture::start(false, true).await;
    assert!(matches!(
        stalled
            .exchange(
                Limits {
                    timeout: Duration::from_millis(150),
                    ..limits()
                },
                || Ok(())
            )
            .await,
        Err(Failure::Timeout)
    ));
    stalled.closed().await;
}

#[tokio::test]
async fn dropping_confirmed_exchange_closes_only_its_channel_and_releases_capacity() {
    let fixture = Fixture::start(false, true).await;
    let permits = Arc::new(Semaphore::new(1));
    let handle = fixture.handle.clone();
    let capacity = permits.clone();
    let task = tokio::spawn(exchange_with_capacity(
        async move {
            handle
                .channel_open_session()
                .await
                .map_err(|e| AppError::Ssh(e.to_string()))
        },
        "owned-helper send".into(),
        Some("isolated-prompt".into()),
        Limits {
            timeout: Duration::from_secs(30),
            ..limits()
        },
        || Ok(()),
        capacity,
    ));
    tokio::time::timeout(
        Duration::from_secs(3),
        fixture.observation.executed.notified(),
    )
    .await
    .unwrap();
    assert_eq!(permits.available_permits(), 0);
    task.abort();
    assert!(task.await.err().unwrap().is_cancelled());
    fixture.closed().await;
    assert_eq!(permits.available_permits(), 1);
    assert!(!fixture.handle.is_closed());
    let sibling = fixture.handle.channel_open_session().await.unwrap();
    sibling.close().await.unwrap();
}

#[tokio::test]
async fn timed_out_open_holds_capacity_and_closes_late_confirmation_without_dispatch() {
    let fixture = Fixture::start(true, false).await;
    let permits = Arc::new(Semaphore::new(1));
    let handle = fixture.handle.clone();
    let result = exchange_with_capacity(
        async move {
            handle
                .channel_open_session()
                .await
                .map_err(|e| AppError::Ssh(e.to_string()))
        },
        "owned-helper send".into(),
        Some("isolated-prompt".into()),
        Limits {
            timeout: Duration::from_millis(150),
            ..limits()
        },
        || Ok(()),
        permits.clone(),
    )
    .await;
    assert!(matches!(result, Err(Failure::Timeout)));
    assert_eq!(permits.available_permits(), 0);
    let busy = exchange_with_capacity(
        async { panic!("exhausted capacity polled open") },
        "owned-helper send".into(),
        None,
        limits(),
        || Ok(()),
        permits.clone(),
    )
    .await;
    match busy {
        Err(Failure::Connection(error)) => assert_eq!(error.to_string(), "plugin.runners.busy"),
        _ => panic!("unconfirmed open did not retain capacity"),
    }
    fixture
        .observation
        .pending
        .lock()
        .await
        .take()
        .unwrap()
        .accept()
        .await;
    fixture.closed().await;
    assert_eq!(permits.available_permits(), 1);
    assert_eq!(fixture.observation.commands.load(Ordering::SeqCst), 0);
    assert_eq!(fixture.observation.bytes.load(Ordering::SeqCst), 0);
    assert!(fixture.exchange(limits(), || Ok(())).await.is_ok());
}

#[tokio::test]
async fn disposing_parent_settles_cancelled_unconfirmed_open() {
    let fixture = Fixture::start(true, false).await;
    let permits = Arc::new(Semaphore::new(1));
    let handle = fixture.handle.clone();
    let task = tokio::spawn(exchange_with_capacity(
        async move {
            handle
                .channel_open_session()
                .await
                .map_err(|e| AppError::Ssh(e.to_string()))
        },
        "owned-helper send".into(),
        None,
        Limits {
            timeout: Duration::from_secs(30),
            ..limits()
        },
        || Ok(()),
        permits.clone(),
    ));
    tokio::time::timeout(
        Duration::from_secs(3),
        fixture.observation.opened.notified(),
    )
    .await
    .unwrap();
    task.abort();
    assert!(task.await.err().unwrap().is_cancelled());
    assert_eq!(permits.available_permits(), 0);
    fixture
        .handle
        .disconnect(russh::Disconnect::ByApplication, "", "en")
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        while permits.available_permits() == 0 {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("cancelled open survived session disposal");
    assert_eq!(fixture.observation.commands.load(Ordering::SeqCst), 0);
}
