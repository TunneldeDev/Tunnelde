use super::*;
use russh::{
    keys::HashAlg,
    server::{self, Server as _, Session},
    Channel, ChannelId, ChannelMsg,
};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::time::Duration;
use tokio::sync::{Mutex, Notify};

#[derive(Default)]
struct Observation {
    hold: AtomicBool,
    pending: Mutex<Option<server::ChannelOpenHandle>>,
    opened: Notify,
    closed: AtomicUsize,
    commands: AtomicUsize,
    bytes: AtomicUsize,
}
#[derive(Clone)]
struct Server(Arc<Observation>);
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
        if self.0.hold.swap(false, Ordering::SeqCst) {
            *self.0.pending.lock().await = Some(reply);
        } else {
            reply.accept().await;
        }
        self.0.opened.notify_one();
        Ok(())
    }
    async fn exec_request(
        &mut self,
        id: ChannelId,
        _: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.0.commands.fetch_add(1, Ordering::SeqCst);
        session.channel_success(id)?;
        Ok(())
    }
    async fn data(
        &mut self,
        id: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.0.bytes.fetch_add(data.len(), Ordering::SeqCst);
        session.data(id, data.to_vec())?;
        Ok(())
    }
    async fn channel_close(&mut self, _: ChannelId, _: &mut Session) -> Result<(), Self::Error> {
        self.0.closed.fetch_add(1, Ordering::SeqCst);
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
    server: tokio::task::JoinHandle<()>,
}
impl Fixture {
    async fn new(hold: bool) -> Self {
        let socket = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let addr = socket.local_addr().unwrap();
        let key =
            russh::keys::PrivateKey::random(&mut rand::rng(), russh::keys::Algorithm::Ed25519)
                .unwrap();
        let fp = key.public_key().fingerprint(HashAlg::Sha256).to_string();
        let config = Arc::new(server::Config {
            keys: vec![key],
            ..Default::default()
        });
        let observation = Arc::new(Observation::default());
        observation.hold.store(hold, Ordering::SeqCst);
        let mut server = Server(observation.clone());
        let server =
            tokio::spawn(async move { server.run_on_socket(config, &socket).await.unwrap() });
        let mut handle = client::connect(Arc::new(client::Config::default()), addr, Client(fp))
            .await
            .unwrap();
        assert!(handle
            .authenticate_none("ordinary-task-open-test")
            .await
            .unwrap()
            .success());
        Self {
            handle: Arc::new(handle),
            observation,
            server,
        }
    }
    async fn closed(&self) {
        tokio::time::timeout(Duration::from_secs(3), async {
            while self.observation.closed.load(Ordering::SeqCst) == 0 {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("owned task channel remained open");
    }
    async fn release_open(&self) {
        self.observation
            .pending
            .lock()
            .await
            .take()
            .unwrap()
            .accept()
            .await;
    }
    async fn settled(&self, permits: &Semaphore) {
        self.closed().await;
        tokio::time::timeout(Duration::from_secs(3), async {
            while permits.available_permits() != 1 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("closed task channel retained its capacity");
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.server.abort();
    }
}
fn deadline() -> Instant {
    Instant::now() + Duration::from_secs(3)
}

#[tokio::test]
async fn already_cancelled_task_never_submits_open() {
    let fixture = Fixture::new(false).await;
    let (cancel, mut receiver) = watch::channel(true);
    let permits = Arc::new(Semaphore::new(1));
    assert!(open_with_capacity(
        fixture.handle.clone(),
        deadline(),
        &mut receiver,
        permits.clone()
    )
    .await
    .unwrap()
    .is_none());
    assert_eq!(permits.available_permits(), 1);
    assert!(tokio::time::timeout(
        Duration::from_millis(30),
        fixture.observation.opened.notified()
    )
    .await
    .is_err());
    drop(cancel);
}

#[tokio::test]
async fn expired_budget_and_closed_owner_never_submit_open() {
    let fixture = Fixture::new(false).await;
    let permits = Arc::new(Semaphore::new(1));
    let (cancel, mut receiver) = watch::channel(false);
    let result = open_with_capacity(
        fixture.handle.clone(),
        Instant::now(),
        &mut receiver,
        permits.clone(),
    )
    .await;
    assert_eq!(
        result.err().unwrap().to_string(),
        "plugin.tasks.channelTimeout"
    );
    drop(cancel);
    assert!(open_with_capacity(
        fixture.handle.clone(),
        deadline(),
        &mut receiver,
        permits.clone(),
    )
    .await
    .unwrap()
    .is_none());
    assert_eq!(permits.available_permits(), 1);
    assert!(tokio::time::timeout(
        Duration::from_millis(30),
        fixture.observation.opened.notified()
    )
    .await
    .is_err());
}

#[tokio::test]
async fn cancelled_open_retains_capacity_closes_late_channel_and_never_executes() {
    let fixture = Fixture::new(true).await;
    let (cancel, mut receiver) = watch::channel(false);
    let permits = Arc::new(Semaphore::new(1));
    let handle = fixture.handle.clone();
    let capacity = permits.clone();
    let task = tokio::spawn(async move {
        open_with_capacity(handle, deadline(), &mut receiver, capacity).await
    });
    tokio::time::timeout(
        Duration::from_secs(3),
        fixture.observation.opened.notified(),
    )
    .await
    .unwrap();
    cancel.send_replace(true);
    assert!(task.await.unwrap().unwrap().is_none());
    assert_eq!(permits.available_permits(), 0);
    let (_live, mut next) = watch::channel(false);
    assert_eq!(
        open_with_capacity(
            fixture.handle.clone(),
            deadline(),
            &mut next,
            permits.clone()
        )
        .await
        .err()
        .unwrap()
        .to_string(),
        "plugin.tasks.busy"
    );
    fixture.release_open().await;
    fixture.settled(&permits).await;
    assert_eq!(permits.available_permits(), 1);
    assert_eq!(fixture.observation.commands.load(Ordering::SeqCst), 0);
    assert_eq!(fixture.observation.bytes.load(Ordering::SeqCst), 0);
    assert!(!fixture.handle.is_closed());
}

#[tokio::test]
async fn open_timeout_is_not_a_capacity_release_or_a_retry() {
    let fixture = Fixture::new(true).await;
    let (_cancel, mut receiver) = watch::channel(false);
    let permits = Arc::new(Semaphore::new(1));
    let result = open_with_capacity(
        fixture.handle.clone(),
        Instant::now() + Duration::from_millis(120),
        &mut receiver,
        permits.clone(),
    )
    .await;
    assert_eq!(
        result.err().unwrap().to_string(),
        "plugin.tasks.channelTimeout"
    );
    assert_eq!(permits.available_permits(), 0);
    fixture.release_open().await;
    fixture.settled(&permits).await;
    assert_eq!(permits.available_permits(), 1);
    assert_eq!(fixture.observation.commands.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn confirmed_owner_drop_before_exec_closes_only_its_channel() {
    let fixture = Fixture::new(false).await;
    let (_cancel, mut receiver) = watch::channel(false);
    let permits = Arc::new(Semaphore::new(1));
    let owned = open_with_capacity(
        fixture.handle.clone(),
        deadline(),
        &mut receiver,
        permits.clone(),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(permits.available_permits(), 0);
    drop(owned);
    fixture.settled(&permits).await;
    assert_eq!(fixture.observation.commands.load(Ordering::SeqCst), 0);
    assert!(!fixture.handle.is_closed());
    let sibling = fixture.handle.channel_open_session().await.unwrap();
    sibling.close().await.unwrap();
}

#[tokio::test]
async fn split_channel_drop_closes_its_stream_and_preserves_parent_and_sibling() {
    let fixture = Fixture::new(false).await;
    let (_cancel, mut receiver) = watch::channel(false);
    let permits = Arc::new(Semaphore::new(1));
    let mut owned = open_with_capacity(
        fixture.handle.clone(),
        deadline(),
        &mut receiver,
        permits.clone(),
    )
    .await
    .unwrap()
    .unwrap();
    owned.channel().exec(true, "owned-test").await.unwrap();
    let mut split = owned.split();
    let (reader, writer) = split.parts();
    writer.data(b"stream roundtrip".as_slice()).await.unwrap();
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            if let Some(ChannelMsg::Data { data }) = reader.wait().await {
                assert_eq!(&data[..], b"stream roundtrip");
                break;
            }
        }
    })
    .await
    .unwrap();
    assert_eq!(permits.available_permits(), 0);
    drop(split);
    fixture.settled(&permits).await;
    assert_eq!(permits.available_permits(), 1);
    assert!(!fixture.handle.is_closed());
    let sibling = fixture.handle.channel_open_session().await.unwrap();
    sibling.close().await.unwrap();
}

#[tokio::test]
async fn parent_disposal_releases_abandoned_open_without_command() {
    let fixture = Fixture::new(true).await;
    let (_cancel, mut receiver) = watch::channel(false);
    let permits = Arc::new(Semaphore::new(1));
    let handle = fixture.handle.clone();
    let capacity = permits.clone();
    let task = tokio::spawn(async move {
        open_with_capacity(handle, deadline(), &mut receiver, capacity).await
    });
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
    .unwrap();
    assert_eq!(fixture.observation.commands.load(Ordering::SeqCst), 0);
}
