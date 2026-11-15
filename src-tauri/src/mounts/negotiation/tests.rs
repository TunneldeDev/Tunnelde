use super::*;
use russh::{
    keys::HashAlg,
    server::{self, Server as _, Session},
    Channel, ChannelId,
};
use std::{
    collections::HashMap,
    sync::atomic::{AtomicUsize, Ordering},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    sync::{Mutex, Notify},
    task::JoinHandle,
};

#[derive(Clone, Copy)]
enum Reply {
    Success,
    Reject,
    Stall,
    Eof,
    EarlyData,
    DiagnosticFlood,
    DelayedOpen,
}

#[derive(Default)]
struct Observation {
    requested: Notify,
    opened: Notify,
    closed: AtomicUsize,
    pending: Mutex<Vec<server::ChannelOpenHandle>>,
}

struct Server {
    reply: Reply,
    observation: Arc<Observation>,
    channels: HashMap<ChannelId, Channel<server::Msg>>,
}

impl server::Server for Server {
    type Handler = Self;
    fn new_client(&mut self, _: Option<std::net::SocketAddr>) -> Self {
        Self {
            reply: self.reply,
            observation: self.observation.clone(),
            channels: HashMap::new(),
        }
    }
}

impl server::Handler for Server {
    type Error = russh::Error;
    async fn auth_none(&mut self, _: &str) -> Result<server::Auth, Self::Error> {
        Ok(server::Auth::Accept)
    }
    async fn channel_open_session(
        &mut self,
        channel: Channel<server::Msg>,
        reply: server::ChannelOpenHandle,
        _: &mut Session,
    ) -> Result<(), Self::Error> {
        self.channels.insert(channel.id(), channel);
        if matches!(self.reply, Reply::DelayedOpen) {
            self.observation.pending.lock().await.push(reply);
        } else {
            reply.accept().await;
        }
        self.observation.opened.notify_one();
        Ok(())
    }
    async fn subsystem_request(
        &mut self,
        id: ChannelId,
        name: &str,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        assert_eq!(name, "sftp");
        match self.reply {
            Reply::Success => {
                session.channel_success(id)?;
            }
            Reply::Reject => {
                session.channel_failure(id)?;
            }
            Reply::Eof => {
                session.eof(id)?;
            }
            Reply::EarlyData => {
                session.data(id, b"invalid-before-init".as_slice())?;
            }
            Reply::DiagnosticFlood => {
                session.extended_data(id, 1, vec![b'x'; 16385])?;
            }
            Reply::Stall | Reply::DelayedOpen => {}
        }
        self.observation.requested.notify_one();
        Ok(())
    }
    async fn data(
        &mut self,
        id: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.data(id, data.to_vec())?;
        Ok(())
    }
    async fn channel_close(&mut self, id: ChannelId, _: &mut Session) -> Result<(), Self::Error> {
        self.channels.remove(&id);
        self.observation.closed.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

struct Client {
    fingerprint: String,
}
impl client::Handler for Client {
    type Error = russh::Error;
    async fn check_server_key(
        &mut self,
        key: &russh::keys::PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        Ok(key.public_key().fingerprint(HashAlg::Sha256).to_string() == self.fingerprint)
    }
}

struct Fixture {
    handle: Arc<client::Handle<Client>>,
    observation: Arc<Observation>,
    server: JoinHandle<()>,
}
impl Fixture {
    async fn start(reply: Reply) -> Self {
        let socket = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let address = socket.local_addr().unwrap();
        let key =
            russh::keys::PrivateKey::random(&mut rand::rng(), russh::keys::Algorithm::Ed25519)
                .unwrap();
        let fingerprint = key.public_key().fingerprint(HashAlg::Sha256).to_string();
        let config = Arc::new(server::Config {
            keys: vec![key],
            ..Default::default()
        });
        let observation = Arc::new(Observation::default());
        let mut server = Server {
            reply,
            observation: observation.clone(),
            channels: HashMap::new(),
        };
        let server = tokio::spawn(async move {
            server.run_on_socket(config, &socket).await.unwrap();
        });
        let mut handle = client::connect(
            Arc::new(client::Config::default()),
            address,
            Client { fingerprint },
        )
        .await
        .unwrap();
        assert!(handle
            .authenticate_none("sshfs-negotiation-test")
            .await
            .unwrap()
            .success());
        Self {
            handle: Arc::new(handle),
            observation,
            server,
        }
    }
    async fn closed(&self, expected: usize) {
        tokio::time::timeout(Duration::from_secs(3), async {
            while self.observation.closed.load(Ordering::SeqCst) < expected {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("owned SSH channel did not close");
    }
    async fn sibling_roundtrip(&self) {
        let mut sibling = self
            .handle
            .channel_open_session()
            .await
            .unwrap()
            .into_stream();
        sibling.write_all(b"sibling remains usable").await.unwrap();
        let mut data = [0; 22];
        tokio::time::timeout(Duration::from_secs(3), sibling.read_exact(&mut data))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(&data, b"sibling remains usable");
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.server.abort();
    }
}

#[tokio::test]
async fn confirms_success_before_returning_stream_and_keeps_parent_usable() {
    let fixture = Fixture::start(Reply::Success).await;
    let permits = Arc::new(Semaphore::new(1));
    let mut stream = prepare_with_budget(
        fixture.handle.clone(),
        permits.clone(),
        Duration::from_secs(3),
    )
    .await
    .unwrap();
    assert_eq!(permits.available_permits(), 1);
    stream.write_all(b"sftp bytes").await.unwrap();
    let mut bytes = [0; 10];
    tokio::time::timeout(Duration::from_secs(3), stream.read_exact(&mut bytes))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(&bytes, b"sftp bytes");
    drop(stream);
    fixture.closed(1).await;
    fixture.sibling_roundtrip().await;
}

#[tokio::test]
async fn rejection_eof_and_premature_data_close_only_owned_channel() {
    for (reply, reason) in [
        (Reply::Reject, "mounts.subsystemRejected"),
        (Reply::Eof, "mounts.transportClosed"),
        (Reply::EarlyData, "mounts.subsystemProtocol"),
        (Reply::DiagnosticFlood, "mounts.subsystemProtocol"),
    ] {
        let fixture = Fixture::start(reply).await;
        let error = prepare_with_budget(
            fixture.handle.clone(),
            Arc::new(Semaphore::new(1)),
            Duration::from_secs(3),
        )
        .await
        .err()
        .expect("expected failure");
        assert_eq!(error.to_string(), reason);
        fixture.closed(1).await;
        fixture.sibling_roundtrip().await;
    }
}

#[tokio::test]
async fn stalled_subsystem_times_out_and_returns_capacity() {
    let fixture = Fixture::start(Reply::Stall).await;
    let permits = Arc::new(Semaphore::new(1));
    let error = prepare_with_budget(
        fixture.handle.clone(),
        permits.clone(),
        Duration::from_millis(200),
    )
    .await
    .err()
    .expect("expected failure");
    assert_eq!(error.to_string(), "mounts.negotiationTimeout");
    fixture.closed(1).await;
    assert_eq!(permits.available_permits(), 1);
    fixture.sibling_roundtrip().await;
}

#[tokio::test]
async fn cancelling_subsystem_wait_closes_channel_without_waiting_for_timeout() {
    let fixture = Fixture::start(Reply::Stall).await;
    let permits = Arc::new(Semaphore::new(1));
    let task = tokio::spawn(prepare_with_budget(
        fixture.handle.clone(),
        permits.clone(),
        Duration::from_secs(30),
    ));
    tokio::time::timeout(
        Duration::from_secs(3),
        fixture.observation.requested.notified(),
    )
    .await
    .unwrap();
    task.abort();
    assert!(task.await.err().expect("expected failure").is_cancelled());
    fixture.closed(1).await;
    assert_eq!(permits.available_permits(), 1);
    fixture.sibling_roundtrip().await;
}

#[tokio::test]
async fn timed_out_open_retains_bounded_waiter_and_closes_late_confirmation() {
    let fixture = Fixture::start(Reply::DelayedOpen).await;
    let permits = Arc::new(Semaphore::new(1));
    let error = prepare_with_budget(
        fixture.handle.clone(),
        permits.clone(),
        Duration::from_millis(200),
    )
    .await
    .err()
    .expect("expected failure");
    assert_eq!(error.to_string(), "mounts.negotiationTimeout");
    assert_eq!(permits.available_permits(), 0);
    let busy = prepare_with_budget(
        fixture.handle.clone(),
        permits.clone(),
        Duration::from_secs(3),
    )
    .await
    .err()
    .expect("expected failure");
    assert_eq!(busy.to_string(), "mounts.connectionBusy");
    let pending = fixture
        .observation
        .pending
        .lock()
        .await
        .pop()
        .expect("pending open");
    pending.accept().await;
    fixture.closed(1).await;
    assert_eq!(permits.available_permits(), 1);
    assert!(!fixture.handle.is_closed());
}

#[tokio::test]
async fn session_disposal_settles_unconfirmed_open() {
    let fixture = Fixture::start(Reply::DelayedOpen).await;
    let permits = Arc::new(Semaphore::new(1));
    let task = tokio::spawn(prepare_with_budget(
        fixture.handle.clone(),
        permits.clone(),
        Duration::from_secs(30),
    ));
    tokio::time::timeout(
        Duration::from_secs(3),
        fixture.observation.opened.notified(),
    )
    .await
    .unwrap();
    task.abort();
    assert!(task.await.err().expect("expected failure").is_cancelled());
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
    .expect("open waiter survived session disposal");
}
