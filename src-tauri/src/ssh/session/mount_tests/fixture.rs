use super::super::*;
use russh::server::{self, Server as _, Session};
use std::sync::atomic::{AtomicUsize, Ordering};

#[derive(Default)]
struct Server {
    channels: HashMap<russh::ChannelId, Channel<server::Msg>>,
    workers: Vec<JoinHandle<()>>,
    subsystems: Arc<AtomicUsize>,
}

impl server::Server for Server {
    type Handler = Self;

    fn new_client(&mut self, _: Option<std::net::SocketAddr>) -> Self {
        Self {
            channels: HashMap::new(),
            workers: Vec::new(),
            subsystems: self.subsystems.clone(),
        }
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        for worker in &self.workers {
            worker.abort();
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
        reply.accept().await;
        Ok(())
    }

    async fn subsystem_request(
        &mut self,
        id: russh::ChannelId,
        name: &str,
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        if name != "sftp" {
            session.channel_failure(id)?;
            return Ok(());
        }
        let channel = self.channels.remove(&id).expect("owned subsystem channel");
        let mut child = tokio::process::Command::new("/usr/lib/openssh/sftp-server")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::inherit())
            .kill_on_drop(true)
            .spawn()
            .expect("isolated OpenSSH sftp-server");
        let mut pipes = tokio::io::join(child.stdout.take().unwrap(), child.stdin.take().unwrap());
        session.channel_success(id)?;
        self.subsystems.fetch_add(1, Ordering::SeqCst);
        self.workers.push(tokio::spawn(async move {
            let mut channel = channel.into_stream();
            let _ = tokio::io::copy_bidirectional(&mut channel, &mut pipes).await;
            drop(pipes);
            if tokio::time::timeout(Duration::from_secs(2), child.wait())
                .await
                .is_err()
            {
                let _ = child.kill().await;
            }
        }));
        Ok(())
    }
}

pub(super) struct Fixture {
    address: std::net::SocketAddr,
    fingerprint: String,
    server: JoinHandle<()>,
    subsystems: Arc<AtomicUsize>,
}

impl Fixture {
    pub(super) async fn start() -> Self {
        let socket = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let address = socket.local_addr().unwrap();
        let key =
            russh::keys::PrivateKey::random(&mut rand::rng(), russh::keys::Algorithm::Ed25519)
                .unwrap();
        let fingerprint = key.public_key().fingerprint(HashAlg::Sha256).to_string();
        let config = server::Config {
            keys: vec![key],
            ..server::Config::default()
        };
        let mut server = Server::default();
        let subsystems = server.subsystems.clone();
        let server = tokio::spawn(async move {
            server
                .run_on_socket(Arc::new(config), &socket)
                .await
                .unwrap();
        });
        Self {
            address,
            fingerprint,
            server,
            subsystems,
        }
    }

    pub(super) async fn connect(&self, manager: &SshManager, id: &str) {
        let stream = tokio::net::TcpStream::connect(self.address).await.unwrap();
        let (mut client, observed, _) = handshake(Box::pin(stream), Some(self.fingerprint.clone()))
            .await
            .unwrap();
        assert_eq!(observed.fingerprint, self.fingerprint);
        assert!(client
            .authenticate_none("isolated-sshfs-qa")
            .await
            .unwrap()
            .success());
        let (writer, _receiver) = mpsc::channel(1);
        manager.insert(SessionHandle {
            published: true,
            user_managed: true,
            server_key: self.fingerprint.clone(),
            info: SessionInfo {
                id: id.into(),
                host_id: "isolated-loopback-sshfs".into(),
                title: "SSHFS integration fixture".into(),
                address: self.address.to_string(),
                cols: 80,
                rows: 24,
                connected_at: 1,
                terminal: false,
                purpose: Some("files".into()),
            },
            writer,
            task: tokio::spawn(std::future::pending()),
            handle: Arc::new(client),
            _jumps: vec![],
            remote_forwards: Arc::default(),
        });
    }

    pub(super) fn subsystem_count(&self) -> usize {
        self.subsystems.load(Ordering::SeqCst)
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        self.server.abort();
    }
}
