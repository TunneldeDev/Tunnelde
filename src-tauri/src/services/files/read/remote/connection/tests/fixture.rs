use super::*;
use russh::{
    keys::HashAlg,
    server::{self, Server as _, Session},
    Channel, ChannelId,
};
use russh_sftp::protocol::{Attrs, Data, Handle, Status, StatusCode};
use std::{
    collections::HashMap,
    sync::atomic::{AtomicBool, AtomicUsize, Ordering},
};
use tokio::sync::{Mutex, Notify};

#[derive(Default)]
pub(super) struct Seen {
    pub hold: AtomicBool,
    pub stall: AtomicBool,
    pub reject: AtomicBool,
    pub pending: Mutex<Option<server::ChannelOpenHandle>>,
    pub opened: Notify,
    pub subsystem: Notify,
    pub subsystems: AtomicUsize,
    pub closed: AtomicUsize,
    pub finished: AtomicUsize,
    workers: std::sync::Mutex<Vec<tokio::task::JoinHandle<()>>>,
}
struct Server {
    seen: Arc<Seen>,
    channels: HashMap<ChannelId, Channel<server::Msg>>,
}
impl server::Server for Server {
    type Handler = Self;
    fn new_client(&mut self, _: Option<std::net::SocketAddr>) -> Self {
        Self {
            seen: self.seen.clone(),
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
        if self.seen.hold.swap(false, Ordering::SeqCst) {
            *self.seen.pending.lock().await = Some(reply);
        } else {
            reply.accept().await;
        }
        self.seen.opened.notify_one();
        Ok(())
    }
    async fn subsystem_request(
        &mut self,
        id: ChannelId,
        name: &str,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        assert_eq!(name, "sftp");
        self.seen.subsystems.fetch_add(1, Ordering::SeqCst);
        self.seen.subsystem.notify_one();
        if self.seen.reject.load(Ordering::SeqCst) {
            session.channel_failure(id)?;
            session.close(id)?;
            return Ok(());
        }
        session.channel_success(id)?;
        if !self.seen.stall.load(Ordering::SeqCst) {
            let stream = self.channels.remove(&id).unwrap().into_stream();
            self.seen
                .workers
                .lock()
                .unwrap()
                .push(tokio::spawn(russh_sftp::server::run(
                    stream,
                    Sftp(self.seen.clone()),
                )));
        }
        Ok(())
    }
    async fn channel_close(&mut self, id: ChannelId, _: &mut Session) -> Result<(), Self::Error> {
        self.channels.remove(&id);
        self.seen.closed.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}
struct Sftp(Arc<Seen>);
impl Drop for Sftp {
    fn drop(&mut self) {
        // The SFTP server owns this handler until its stream loop ends. On EOF
        // its stream can retire the SSH channel before a reciprocal Close is
        // delivered to server::Handler::channel_close (notably on Linux).
        self.0.finished.fetch_add(1, Ordering::SeqCst);
    }
}
const BYTES: &[u8] = b"read-only SSH fixture";
fn attributes(id: u32) -> Attrs {
    Attrs {
        id,
        attrs: FileAttributes {
            size: Some(BYTES.len() as u64),
            permissions: Some(0o100600),
            ..FileAttributes::empty()
        },
    }
}
impl russh_sftp::server::Handler for Sftp {
    type Error = StatusCode;
    fn unimplemented(&self) -> Self::Error {
        StatusCode::OpUnsupported
    }
    async fn stat(&mut self, id: u32, path: String) -> Result<Attrs, Self::Error> {
        assert_eq!(path, "/source.bin");
        Ok(attributes(id))
    }
    async fn fstat(&mut self, id: u32, handle: String) -> Result<Attrs, Self::Error> {
        assert_eq!(handle, "reader");
        Ok(attributes(id))
    }
    async fn open(
        &mut self,
        id: u32,
        path: String,
        flags: OpenFlags,
        _: FileAttributes,
    ) -> Result<Handle, Self::Error> {
        assert_eq!(path, "/source.bin");
        assert_eq!(flags.bits(), OpenFlags::READ.bits());
        Ok(Handle {
            id,
            handle: "reader".into(),
        })
    }
    async fn read(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        len: u32,
    ) -> Result<Data, Self::Error> {
        assert_eq!(handle, "reader");
        let start = offset as usize;
        if start >= BYTES.len() {
            return Err(StatusCode::Eof);
        }
        Ok(Data {
            id,
            data: BYTES[start..(start + len as usize).min(BYTES.len())].to_vec(),
        })
    }
    async fn close(&mut self, id: u32, handle: String) -> Result<Status, Self::Error> {
        assert_eq!(handle, "reader");
        Ok(Status {
            id,
            status_code: StatusCode::Ok,
            error_message: String::new(),
            language_tag: "en".into(),
        })
    }
}
pub(super) struct Client(String);
impl russh::client::Handler for Client {
    type Error = russh::Error;
    async fn check_server_key(
        &mut self,
        key: &russh::keys::PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        Ok(key.public_key().fingerprint(HashAlg::Sha256).to_string() == self.0)
    }
}
pub(super) struct Fixture {
    pub handle: Arc<russh::client::Handle<Client>>,
    pub seen: Arc<Seen>,
    server: tokio::task::JoinHandle<()>,
}
impl Fixture {
    pub async fn new(hold: bool) -> Self {
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
        let mut server = Server {
            seen: seen.clone(),
            channels: HashMap::new(),
        };
        let config = Arc::new(server::Config {
            keys: vec![key],
            ..Default::default()
        });
        let server =
            tokio::spawn(async move { server.run_on_socket(config, &socket).await.unwrap() });
        let mut handle = russh::client::connect(
            Arc::new(russh::client::Config::default()),
            addr,
            Client(fingerprint),
        )
        .await
        .unwrap();
        assert!(handle
            .authenticate_none("file-reader-owner-test")
            .await
            .unwrap()
            .success());
        Self {
            handle: Arc::new(handle),
            seen,
            server,
        }
    }
    pub async fn release(&self) {
        self.seen
            .pending
            .lock()
            .await
            .take()
            .unwrap()
            .accept()
            .await;
    }
    pub async fn settled(&self, capacity: &Semaphore) {
        tokio::time::timeout(deadline(), async {
            while self.seen.closed.load(Ordering::SeqCst) == 0 || capacity.available_permits() != 1
            {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("reader channel or connection slot did not retire");
    }
    pub async fn open(&self, capacity: &Arc<Semaphore>) -> AppResult<(RemoteReader, u64)> {
        let (job, _pending) = cancellation();
        RemoteReader::open_on(
            self.handle.clone(),
            "/source.bin".into(),
            &job,
            capacity.clone().try_acquire_owned().unwrap(),
            deadline(),
        )
        .await
    }
    pub async fn read(&self) {
        let finished_before = self.seen.finished.load(Ordering::SeqCst);
        let capacity = Arc::new(Semaphore::new(1));
        let (reader, size) = self.open(&capacity).await.unwrap();
        assert_eq!(size, BYTES.len() as u64);
        assert_eq!(reader.read(0, size).await.unwrap(), BYTES);
        assert_eq!(capacity.available_permits(), 0);
        reader.close().await;
        tokio::time::timeout(deadline(), async {
            while self.seen.finished.load(Ordering::SeqCst) <= finished_before
                || capacity.available_permits() != 1
            {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("accepted reader retained its SFTP server or connection slot");
        assert!(!self.handle.is_closed());
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
