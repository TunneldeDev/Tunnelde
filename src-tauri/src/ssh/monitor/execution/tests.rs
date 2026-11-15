use super::*;
use russh::{
    client,
    keys::HashAlg,
    server::{self, Server as _, Session},
    Channel, ChannelId,
};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use tokio::sync::{Mutex, Notify};

#[derive(Default)]
struct Seen {
    hold: AtomicBool,
    pending: Mutex<Option<server::ChannelOpenHandle>>,
    opened: Notify,
    executed: Notify,
    commands: AtomicUsize,
    closed: AtomicUsize,
    workers: std::sync::Mutex<Vec<tokio::task::JoinHandle<()>>>,
}
#[derive(Clone)]
struct Server(Arc<Seen>);
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
        command: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.0.commands.fetch_add(1, Ordering::SeqCst);
        self.0.executed.notify_one();
        session.channel_success(id)?;
        match command {
            b"stall" => return Ok(()),
            b"large" => {
                for _ in 0..129 {
                    session.data(id, vec![b'x'; 64 * 1024])?;
                }
            }
            _ => {
                session.data(id, "结果\n".as_bytes())?;
                session.extended_data(id, 1, b"diagnostic".as_slice())?;
            }
        }
        session.exit_status_request(id, 7)?;
        session.eof(id)?;
        session.close(id)?;
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
    seen: Arc<Seen>,
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
        let fingerprint = key.public_key().fingerprint(HashAlg::Sha256).to_string();
        let seen = Arc::new(Seen::default());
        seen.hold.store(hold, Ordering::SeqCst);
        let mut server = Server(seen.clone());
        let config = Arc::new(server::Config {
            keys: vec![key],
            ..Default::default()
        });
        let server =
            tokio::spawn(async move { server.run_on_socket(config, &socket).await.unwrap() });
        let mut handle = client::connect(
            Arc::new(client::Config::default()),
            addr,
            Client(fingerprint),
        )
        .await
        .unwrap();
        assert!(handle
            .authenticate_none("monitor-owner-test")
            .await
            .unwrap()
            .success());
        Self {
            handle: Arc::new(handle),
            seen,
            server,
        }
    }
    async fn release(&self) {
        self.seen
            .pending
            .lock()
            .await
            .take()
            .unwrap()
            .accept()
            .await;
    }
    async fn settled(&self, capacity: &Semaphore) {
        tokio::time::timeout(Duration::from_secs(3), async {
            while self.seen.closed.load(Ordering::SeqCst) == 0 || capacity.available_permits() != 1
            {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("exec channel or capacity did not retire");
    }
    async fn released(&self, capacity: &Semaphore) {
        tokio::time::timeout(Duration::from_secs(3), async {
            while capacity.available_permits() != 1 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("completed exec retained its capacity");
    }
    async fn reply(&self) -> String {
        run(
            self.handle.clone(),
            "reply".into(),
            budget(),
            Arc::new(Semaphore::new(1)),
        )
        .await
        .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        for worker in self.seen.workers.lock().unwrap().drain(..) {
            worker.abort();
        }
        self.server.abort();
    }
}
fn budget() -> Duration {
    Duration::from_secs(3)
}

#[tokio::test]
async fn monitoring_output_preserves_utf8_and_parent_session() {
    let f = Fixture::new(false).await;
    assert_eq!(f.reply().await, "结果\n");
    assert_eq!(f.seen.commands.load(Ordering::SeqCst), 1);
    assert!(!f.handle.is_closed());
}

#[tokio::test]
async fn timeout_keeps_pending_open_owned_until_late_confirmation() {
    let f = Fixture::new(true).await;
    let capacity = Arc::new(Semaphore::new(1));
    let error = run(
        f.handle.clone(),
        "reply".into(),
        Duration::from_millis(150),
        capacity.clone(),
    )
    .await
    .unwrap_err();
    assert_eq!(error.to_string(), "monitor.timeout");
    assert_eq!(capacity.available_permits(), 0);
    let queued = run(
        f.handle.clone(),
        "reply".into(),
        Duration::from_millis(30),
        capacity.clone(),
    )
    .await
    .unwrap_err();
    assert_eq!(queued.to_string(), "monitor.timeout");
    assert_eq!(f.seen.commands.load(Ordering::SeqCst), 0);
    f.release().await;
    f.settled(&capacity).await;
    assert_eq!(f.seen.commands.load(Ordering::SeqCst), 0);
    f.reply().await;
    assert_eq!(f.seen.commands.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn abort_during_open_closes_late_channel_without_sampling() {
    let f = Fixture::new(true).await;
    let capacity = Arc::new(Semaphore::new(1));
    let call = tokio::spawn(run(
        f.handle.clone(),
        "reply".into(),
        budget(),
        capacity.clone(),
    ));
    tokio::time::timeout(budget(), f.seen.opened.notified())
        .await
        .unwrap();
    call.abort();
    assert!(call.await.unwrap_err().is_cancelled());
    assert_eq!(capacity.available_permits(), 0);
    f.release().await;
    f.settled(&capacity).await;
    assert_eq!(f.seen.commands.load(Ordering::SeqCst), 0);
    f.reply().await;
}

#[tokio::test]
async fn disposal_retires_pending_open_and_returns_capacity() {
    let f = Fixture::new(true).await;
    let capacity = Arc::new(Semaphore::new(1));
    let call = tokio::spawn(run(
        f.handle.clone(),
        "reply".into(),
        budget(),
        capacity.clone(),
    ));
    tokio::time::timeout(budget(), f.seen.opened.notified())
        .await
        .unwrap();
    call.abort();
    assert!(call.await.unwrap_err().is_cancelled());
    f.handle
        .disconnect(russh::Disconnect::ByApplication, "", "en")
        .await
        .unwrap();
    f.released(&capacity).await;
    assert_eq!(f.seen.commands.load(Ordering::SeqCst), 0);
}

#[tokio::test]
async fn active_sample_abort_closes_only_its_channel() {
    let f = Fixture::new(false).await;
    let capacity = Arc::new(Semaphore::new(1));
    let call = tokio::spawn(run(
        f.handle.clone(),
        "stall".into(),
        budget(),
        capacity.clone(),
    ));
    tokio::time::timeout(budget(), f.seen.executed.notified())
        .await
        .unwrap();
    call.abort();
    assert!(call.await.unwrap_err().is_cancelled());
    f.settled(&capacity).await;
    f.reply().await;
}

#[tokio::test]
async fn active_timeout_closes_channel_and_parent_remains_usable() {
    let f = Fixture::new(false).await;
    let capacity = Arc::new(Semaphore::new(1));
    let error = run(
        f.handle.clone(),
        "stall".into(),
        Duration::from_millis(150),
        capacity.clone(),
    )
    .await
    .unwrap_err();
    assert_eq!(error.to_string(), "monitor.timeout");
    f.settled(&capacity).await;
    f.reply().await;
}

#[tokio::test]
async fn output_limit_reclaims_capacity_without_disconnect() {
    let f = Fixture::new(false).await;
    let capacity = Arc::new(Semaphore::new(1));
    let error = run(f.handle.clone(), "large".into(), budget(), capacity.clone())
        .await
        .unwrap_err();
    assert_eq!(error.to_string(), "monitor.outputLimit");
    f.released(&capacity).await;
    f.reply().await;
}
