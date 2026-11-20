use super::*;
use russh::{
    keys::HashAlg,
    server::{self, Server as _, Session},
    Channel, ChannelId,
};
use russh_sftp::protocol::{Attrs, File, FileAttributes, Handle, Name, Status, StatusCode};
use std::collections::HashMap;
use tokio::sync::{Mutex, Notify};

#[derive(Default)]
pub(crate) struct Seen {
    pub hold: AtomicBool,
    pub hold_close: AtomicBool,
    pub close_received: Notify,
    pub release_close: Notify,
    pub stall: AtomicBool,
    pub reject: AtomicBool,
    pub delay_stat: AtomicBool,
    pub invalid_name: AtomicBool,
    pub flood: AtomicBool,
    pub stat_is_file: AtomicBool,
    pub pending: Mutex<Option<server::ChannelOpenHandle>>,
    pub opened: Notify,
    pub subsystem: Notify,
    pub stat: Notify,
    pub release_stat: Notify,
    pub closed: AtomicUsize,
    pub finished: AtomicUsize,
    pub opens: AtomicUsize,
    pub reads: AtomicUsize,
    pub handles_closed: AtomicUsize,
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
        self.seen.opens.fetch_add(1, Ordering::SeqCst);
        if self.seen.hold.swap(false, Ordering::SeqCst) {
            *self.seen.pending.lock().await = Some(reply)
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
        self.seen.subsystem.notify_one();
        if self.seen.reject.load(Ordering::SeqCst) {
            session.channel_failure(id)?;
            return Ok(());
        }
        if self.seen.stall.load(Ordering::SeqCst) {
            return Ok(());
        }
        session.channel_success(id)?;
        let stream = self.channels.remove(&id).unwrap().into_stream();
        self.seen
            .workers
            .lock()
            .unwrap()
            .push(tokio::spawn(russh_sftp::server::run(
                stream,
                Sftp {
                    seen: self.seen.clone(),
                    page: 0,
                },
            )));
        Ok(())
    }
    async fn channel_close(&mut self, id: ChannelId, _: &mut Session) -> Result<(), Self::Error> {
        self.channels.remove(&id);
        self.seen.closed.fetch_add(1, Ordering::SeqCst);
        self.seen.close_received.notify_one();
        if self.seen.hold_close.load(Ordering::SeqCst) {
            self.seen.release_close.notified().await;
        }
        Ok(())
    }
}
struct Sftp {
    seen: Arc<Seen>,
    page: usize,
}
impl Drop for Sftp {
    fn drop(&mut self) {
        self.seen.finished.fetch_add(1, Ordering::SeqCst);
    }
}
fn attrs(directory: bool) -> FileAttributes {
    FileAttributes {
        permissions: Some(if directory { 0o040755 } else { 0o100600 }),
        size: Some(42),
        mtime: Some(100),
        atime: Some(100),
        ..FileAttributes::empty()
    }
}
impl russh_sftp::server::Handler for Sftp {
    type Error = StatusCode;
    fn unimplemented(&self) -> Self::Error {
        StatusCode::OpUnsupported
    }
    async fn realpath(&mut self, id: u32, path: String) -> Result<Name, Self::Error> {
        let path = if path == "." { "/home/qa".into() } else { path };
        Ok(Name {
            id,
            files: vec![File::dummy(path)],
        })
    }
    async fn stat(&mut self, id: u32, _: String) -> Result<Attrs, Self::Error> {
        self.seen.stat.notify_one();
        if self.seen.delay_stat.load(Ordering::SeqCst) {
            self.seen.release_stat.notified().await;
        }
        Ok(Attrs {
            id,
            attrs: attrs(!self.seen.stat_is_file.load(Ordering::SeqCst)),
        })
    }
    async fn opendir(&mut self, id: u32, _: String) -> Result<Handle, Self::Error> {
        Ok(Handle {
            id,
            handle: "directory".into(),
        })
    }
    async fn readdir(&mut self, id: u32, handle: String) -> Result<Name, Self::Error> {
        assert_eq!(handle, "directory");
        self.seen.reads.fetch_add(1, Ordering::SeqCst);
        if !self.seen.flood.load(Ordering::SeqCst) && self.page > 0 {
            return Err(StatusCode::Eof);
        }
        self.page += 1;
        let files = if self.seen.invalid_name.load(Ordering::SeqCst) {
            vec![File::new("../escape", attrs(true))]
        } else if self.seen.flood.load(Ordering::SeqCst) {
            (0..256)
                .map(|i| File::new(format!("directory-{i}"), attrs(true)))
                .collect()
        } else {
            let mut files = vec![
                File::new(".", attrs(true)),
                File::new("..", attrs(true)),
                File::new("not-directory", attrs(false)),
                File::new(".hidden", attrs(true)),
            ];
            files.extend(
                (0..260)
                    .rev()
                    .map(|i| File::new(format!("dir-{i:03}"), attrs(true))),
            );
            files
        };
        Ok(Name { id, files })
    }
    async fn close(&mut self, id: u32, _: String) -> Result<Status, Self::Error> {
        self.seen.handles_closed.fetch_add(1, Ordering::SeqCst);
        Ok(Status {
            id,
            status_code: StatusCode::Ok,
            error_message: String::new(),
            language_tag: "en".into(),
        })
    }
}
pub(crate) struct Client(String);
impl client::Handler for Client {
    type Error = russh::Error;
    async fn check_server_key(
        &mut self,
        key: &russh::keys::PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        Ok(key.public_key().fingerprint(HashAlg::Sha256).to_string() == self.0)
    }
}
pub(crate) struct Fixture {
    pub handle: Arc<client::Handle<Client>>,
    pub seen: Arc<Seen>,
    server: tokio::task::JoinHandle<()>,
}
impl Fixture {
    pub async fn new() -> Self {
        let socket = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let addr = socket.local_addr().unwrap();
        let key =
            russh::keys::PrivateKey::random(&mut rand::rng(), russh::keys::Algorithm::Ed25519)
                .unwrap();
        let fingerprint = key.public_key().fingerprint(HashAlg::Sha256).to_string();
        let seen = Arc::new(Seen::default());
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
        let mut handle = client::connect(
            Arc::new(client::Config::default()),
            addr,
            Client(fingerprint),
        )
        .await
        .unwrap();
        assert!(handle
            .authenticate_none("mount-path-qa")
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
        tokio::time::timeout(Duration::from_secs(5), async {
            while capacity.available_permits() != 1 {
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("directory channel capacity did not settle");
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
