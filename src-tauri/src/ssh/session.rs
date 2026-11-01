use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use russh::client::{self, Handle};
use russh::keys::{HashAlg, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use russh::{Channel, ChannelMsg};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::db;
use crate::error::{AppError, AppResult};
use crate::models::{now_ms, Host};
use crate::state::AppState;

pub const DATA_EVENT: &str = "ssh://data";
pub const CLOSED_EVENT: &str = "ssh://closed";

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const TERM: &str = "xterm-256color";
const MAX_EARLY_OUTPUT: usize = 1024 * 1024;

fn default_cols() -> u32 {
    120
}

fn default_rows() -> u32 {
    32
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum HostKeyStatus {
    Known,
    Unknown,
    Changed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyInfo {
    pub fingerprint: String,
    pub algorithm: String,
    pub status: HostKeyStatus,
    pub known_fingerprint: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshConnectRequest {
    pub host_id: String,
    #[serde(default)]
    pub password: Option<String>,
    #[serde(default)]
    pub passphrase: Option<String>,
    #[serde(default = "default_cols")]
    pub cols: u32,
    #[serde(default = "default_rows")]
    pub rows: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: String,
    pub host_id: String,
    pub title: String,
    pub address: String,
    pub cols: u32,
    pub rows: u32,
    pub connected_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DataPayload {
    session_id: String,
    data: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClosedPayload {
    session_id: String,
    reason: String,
}

#[derive(Debug, Clone)]
struct ObservedKey {
    fingerprint: String,
    algorithm: String,
}

pub(crate) struct ClientHandler {
    expected: Option<String>,
    observed: Arc<StdMutex<Option<ObservedKey>>>,
}

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let public = server_public_key.public_key();
        let observed = ObservedKey {
            fingerprint: public.fingerprint(HashAlg::Sha256).to_string(),
            algorithm: public.algorithm().to_string(),
        };
        if let Ok(mut slot) = self.observed.lock() {
            *slot = Some(observed.clone());
        }
        Ok(match self.expected.as_deref() {
            Some(expected) => expected == observed.fingerprint,
            None => true,
        })
    }
}

enum WriterMsg {
    Attach,
    Data(Vec<u8>),
    Resize { cols: u32, rows: u32 },
    Close,
}

struct SessionHandle {
    info: SessionInfo,
    writer: mpsc::Sender<WriterMsg>,
    task: JoinHandle<()>,
    handle: Arc<Handle<ClientHandler>>,
}

#[derive(Default)]
pub struct SshManager {
    sessions: StdMutex<HashMap<String, SessionHandle>>,
}

impl SshManager {
    fn insert(&self, handle: SessionHandle) {
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.insert(handle.info.id.clone(), handle);
        }
    }

    pub(crate) fn handle(&self, session_id: &str) -> AppResult<Arc<Handle<ClientHandler>>> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| AppError::internal("ssh.lock"))?;
        sessions
            .get(session_id)
            .map(|session| session.handle.clone())
            .ok_or_else(|| AppError::Ssh("ssh.sessionMissing".into()))
    }

    fn remove(&self, session_id: &str) {
        if let Ok(mut sessions) = self.sessions.lock() {
            if let Some(handle) = sessions.remove(session_id) {
                handle.task.abort();
            }
        }
    }

    pub fn list(&self) -> Vec<SessionInfo> {
        self.sessions
            .lock()
            .map(|sessions| {
                sessions
                    .values()
                    .map(|handle| handle.info.clone())
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn write(&self, session_id: &str, data: Vec<u8>) -> AppResult<()> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| AppError::internal("ssh.lock"))?;
        let handle = sessions
            .get(session_id)
            .ok_or_else(|| AppError::Ssh("ssh.sessionMissing".into()))?;
        handle
            .writer
            .try_send(WriterMsg::Data(data))
            .map_err(|_| AppError::Ssh("ssh.sessionBusy".into()))
    }

    pub fn attach(&self, session_id: &str) -> AppResult<()> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| AppError::internal("ssh.lock"))?;
        let handle = sessions
            .get(session_id)
            .ok_or_else(|| AppError::Ssh("ssh.sessionMissing".into()))?;
        handle
            .writer
            .try_send(WriterMsg::Attach)
            .map_err(|_| AppError::Ssh("ssh.sessionBusy".into()))
    }

    pub fn resize(&self, session_id: &str, cols: u32, rows: u32) -> AppResult<()> {
        let sessions = self
            .sessions
            .lock()
            .map_err(|_| AppError::internal("ssh.lock"))?;
        let handle = sessions
            .get(session_id)
            .ok_or_else(|| AppError::Ssh("ssh.sessionMissing".into()))?;
        let _ = handle.writer.try_send(WriterMsg::Resize { cols, rows });
        Ok(())
    }

    pub fn disconnect(&self, session_id: &str) {
        if let Ok(mut sessions) = self.sessions.lock() {
            if let Some(handle) = sessions.remove(session_id) {
                let _ = handle.writer.try_send(WriterMsg::Close);
                handle.task.abort();
            }
        }
    }
}

fn map_ssh_error(error: russh::Error) -> AppError {
    AppError::Ssh(format!("ssh.error: {error}"))
}

async fn open(
    host: String,
    port: u16,
    expected: Option<String>,
) -> AppResult<(Handle<ClientHandler>, ObservedKey)> {
    let observed = Arc::new(StdMutex::new(None));
    let handler = ClientHandler {
        expected,
        observed: observed.clone(),
    };
    let config = Arc::new(client::Config::default());
    let connected = tokio::time::timeout(
        CONNECT_TIMEOUT,
        client::connect(config, (host.as_str(), port), handler),
    )
    .await
    .map_err(|_| AppError::Ssh("ssh.timeout".into()))?
    .map_err(map_ssh_error)?;

    let observed = observed
        .lock()
        .map_err(|_| AppError::internal("ssh.lock"))?
        .clone()
        .ok_or_else(|| AppError::Ssh("ssh.noHostKey".into()))?;

    Ok((connected, observed))
}

async fn authenticate(
    handle: &mut Handle<ClientHandler>,
    host: &Host,
    request: &SshConnectRequest,
) -> AppResult<()> {
    if host.username.trim().is_empty() {
        return Err(AppError::Ssh("ssh.usernameRequired".into()));
    }

    let result = match host.auth_method.as_str() {
        "agent" => return Err(AppError::Ssh("ssh.agentUnsupported".into())),
        "key" => {
            let path = host
                .key_path
                .clone()
                .ok_or_else(|| AppError::Ssh("ssh.keyPathRequired".into()))?;
            let key = russh::keys::load_secret_key(&path, request.passphrase.as_deref())
                .map_err(|error| AppError::Ssh(format!("ssh.keyLoad: {error}")))?;
            let key = PrivateKeyWithHashAlg::new(Arc::new(key), Some(HashAlg::Sha512));
            handle
                .authenticate_publickey(host.username.clone(), key)
                .await
                .map_err(map_ssh_error)?
        }
        _ => {
            let password = match request.password.clone().filter(|value| !value.is_empty()) {
                Some(password) => password,
                None => crate::vault::load(&host.id)?
                    .ok_or_else(|| AppError::Ssh("ssh.passwordRequired".into()))?,
            };
            handle
                .authenticate_password(host.username.clone(), password)
                .await
                .map_err(map_ssh_error)?
        }
    };

    if result.success() {
        Ok(())
    } else {
        Err(AppError::Ssh("ssh.authFailed".into()))
    }
}

fn emit_data(app: &AppHandle, session_id: &str, data: &[u8]) {
    let _ = app.emit(
        DATA_EVENT,
        DataPayload {
            session_id: session_id.to_string(),
            data: BASE64.encode(data),
        },
    );
}

async fn wait_for_reply(
    channel: &mut Channel<client::Msg>,
    startup: &mut Vec<u8>,
    rejected: &'static str,
) -> AppResult<()> {
    tokio::time::timeout(CONNECT_TIMEOUT, async {
        loop {
            match channel.wait().await {
                Some(ChannelMsg::Success) => return Ok(()),
                Some(ChannelMsg::Failure) => return Err(AppError::Ssh(rejected.into())),
                Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => {
                    if startup.len().saturating_add(data.len()) > MAX_EARLY_OUTPUT {
                        return Err(AppError::Ssh("ssh.startupOutputLimit".into()));
                    }
                    startup.extend_from_slice(&data);
                }
                Some(ChannelMsg::Close | ChannelMsg::Eof) | None => {
                    return Err(AppError::Ssh("ssh.channelClosed".into()));
                }
                _ => {}
            }
        }
    })
    .await
    .map_err(|_| AppError::Ssh("ssh.timeout".into()))?
}

async fn open_terminal_channel(
    handle: &Handle<ClientHandler>,
    cols: u32,
    rows: u32,
) -> AppResult<(Channel<client::Msg>, Vec<u8>)> {
    let mut channel = handle.channel_open_session().await.map_err(map_ssh_error)?;
    // PTY is the authoritative TERM negotiation. Optional env requests may be
    // ignored by AcceptEnv; do not substitute them for a successful PTY reply.
    for (name, value) in [
        ("TERM", TERM),
        ("LANG", "en_US.UTF-8"),
        ("COLORTERM", "truecolor"),
        ("TERM_PROGRAM", "Tunnelde"),
    ] {
        channel
            .set_env(false, name, value)
            .await
            .map_err(map_ssh_error)?;
    }
    let mut startup = Vec::new();
    channel
        .request_pty(true, TERM, cols, rows, 0, 0, &[])
        .await
        .map_err(map_ssh_error)?;
    // russh request_* futures confirm that the request was sent, not accepted.
    wait_for_reply(&mut channel, &mut startup, "ssh.ptyRejected").await?;
    channel.request_shell(true).await.map_err(map_ssh_error)?;
    wait_for_reply(&mut channel, &mut startup, "ssh.shellRejected").await?;
    Ok((channel, startup))
}

async fn pump_terminal(
    channel: Channel<client::Msg>,
    mut outgoing: mpsc::Receiver<WriterMsg>,
    mut startup: Vec<u8>,
    mut emit: impl FnMut(&[u8]),
) {
    let (mut reader, writer) = channel.split();
    let mut attached = false;
    loop {
        tokio::select! {
            // Until both frontend listeners exist, SSH's channel queue/window
            // buffers output without losing a prompt's first ANSI bytes.
            incoming = reader.wait(), if attached => {
                match incoming {
                    Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => emit(&data),
                    Some(ChannelMsg::Close) | None => break,
                    _ => {}
                }
            }
            message = outgoing.recv() => {
                match message {
                    Some(WriterMsg::Attach) => {
                        if !attached {
                            attached = true;
                            if !startup.is_empty() {
                                emit(&startup);
                                startup.clear();
                            }
                        }
                    }
                    Some(WriterMsg::Data(bytes)) => {
                        if writer.data_bytes(bytes).await.is_err() { break; }
                    }
                    Some(WriterMsg::Resize { cols, rows }) => {
                        let _ = writer.window_change(cols, rows, 0, 0).await;
                    }
                    Some(WriterMsg::Close) | None => {
                        let _ = writer.eof().await;
                        let _ = writer.close().await;
                        break;
                    }
                }
            }
        }
    }
}

pub async fn probe(app: &AppHandle, host_id: &str) -> AppResult<HostKeyInfo> {
    let state = app.state::<AppState>();
    let host = state.db.with(|conn| db::hosts::find_host(conn, host_id))?;
    let known = state
        .db
        .with(|conn| db::known_hosts::find(conn, &host.host, host.port as i64))?;

    let (_handle, observed) = open(host.host.clone(), host.port, None).await?;

    let status = match &known {
        None => HostKeyStatus::Unknown,
        Some(entry) if entry.fingerprint == observed.fingerprint => HostKeyStatus::Known,
        Some(_) => HostKeyStatus::Changed,
    };

    Ok(HostKeyInfo {
        fingerprint: observed.fingerprint,
        algorithm: observed.algorithm,
        status,
        known_fingerprint: known.map(|entry| entry.fingerprint),
    })
}

pub async fn trust(app: &AppHandle, host_id: &str) -> AppResult<HostKeyInfo> {
    let state = app.state::<AppState>();
    let host = state.db.with(|conn| db::hosts::find_host(conn, host_id))?;
    let info = probe(app, host_id).await?;

    state.db.with(|conn| {
        db::known_hosts::upsert(
            conn,
            &host.host,
            host.port as i64,
            &info.algorithm,
            &info.fingerprint,
        )
    })?;

    Ok(HostKeyInfo {
        status: HostKeyStatus::Known,
        known_fingerprint: Some(info.fingerprint.clone()),
        ..info
    })
}

pub async fn connect(app: AppHandle, request: SshConnectRequest) -> AppResult<SessionInfo> {
    connect_for_auth(app, request, false).await
}

/// Key setup must authenticate with the supplied password even for a host
/// whose saved authentication method is already a key or agent.
pub(crate) async fn connect_with_password(
    app: AppHandle,
    request: SshConnectRequest,
) -> AppResult<SessionInfo> {
    connect_for_auth(app, request, true).await
}

async fn connect_for_auth(
    app: AppHandle,
    request: SshConnectRequest,
    password_auth: bool,
) -> AppResult<SessionInfo> {
    let state = app.state::<AppState>();
    let mut host = state
        .db
        .with(|conn| db::hosts::find_host(conn, &request.host_id))?;
    if password_auth {
        host.auth_method = "password".into();
    }
    let known = state
        .db
        .with(|conn| db::known_hosts::find(conn, &host.host, host.port as i64))?
        .ok_or_else(|| AppError::Ssh("ssh.hostKeyUntrusted".into()))?;

    let (mut handle, observed) = open(
        host.host.clone(),
        host.port,
        Some(known.fingerprint.clone()),
    )
    .await?;
    if observed.fingerprint != known.fingerprint {
        return Err(AppError::Ssh("ssh.hostKeyChanged".into()));
    }

    authenticate(&mut handle, &host, &request).await?;

    let (channel, startup) = open_terminal_channel(&handle, request.cols, request.rows).await?;

    let session_id = uuid::Uuid::new_v4().to_string();
    let info = SessionInfo {
        id: session_id.clone(),
        host_id: host.id.clone(),
        title: host.name.clone(),
        address: format!("{}@{}:{}", host.username, host.host, host.port),
        cols: request.cols,
        rows: request.rows,
        connected_at: now_ms(),
    };

    let shared_handle = Arc::new(handle);
    let (tx, rx) = mpsc::channel::<WriterMsg>(64);
    let task_app = app.clone();
    let task_session = session_id.clone();

    let task_handle = Arc::clone(&shared_handle);
    let task = tokio::spawn(async move {
        let _session = task_handle;
        pump_terminal(channel, rx, startup, |data| {
            emit_data(&task_app, &task_session, data)
        })
        .await;

        let _ = task_app.emit(
            CLOSED_EVENT,
            ClosedPayload {
                session_id: task_session.clone(),
                reason: "closed".into(),
            },
        );
        if let Some(state) = task_app.try_state::<AppState>() {
            state.ssh.remove(&task_session);
            state.monitor.forget(&task_session);
        }
    });

    state.ssh.insert(SessionHandle {
        info: info.clone(),
        writer: tx,
        task,
        handle: shared_handle,
    });

    tracing::info!(host = %host.name, session = %session_id, "ssh session opened");
    let runner_app = app.clone();
    tokio::spawn(async move {
        crate::plugins::runners::on_reconnect(&runner_app).await;
    });
    Ok(info)
}

pub fn disconnect(app: &AppHandle, session_id: &str) -> AppResult<()> {
    let state = app.state::<AppState>();
    state.ssh.disconnect(session_id);
    Ok(())
}

pub fn attach(app: &AppHandle, session_id: &str) -> AppResult<()> {
    app.state::<AppState>().ssh.attach(session_id)
}

pub fn write(app: &AppHandle, session_id: &str, data: &str) -> AppResult<()> {
    let bytes = BASE64
        .decode(data)
        .map_err(|_| AppError::validation("ssh.invalidPayload"))?;
    let state = app.state::<AppState>();
    state.ssh.write(session_id, bytes)
}

pub fn resize(app: &AppHandle, session_id: &str, cols: u32, rows: u32) -> AppResult<()> {
    let state = app.state::<AppState>();
    state.ssh.resize(session_id, cols, rows)
}

#[cfg(test)]
mod tests {
    use super::*;
    use russh::server::{self, Server as _, Session};
    use russh::{ChannelId, Pty};

    const PROMPT: &[u8] = b"\x1b[01;32muser@server\x1b[0m:\x1b[01;34m~\x1b[0m$ ";

    #[derive(Clone)]
    struct TestServer {
        reject_pty: bool,
        reject_shell: bool,
        requests: Arc<StdMutex<Vec<String>>>,
    }

    impl server::Server for TestServer {
        type Handler = Self;

        fn new_client(&mut self, _: Option<std::net::SocketAddr>) -> Self {
            self.clone()
        }
    }

    impl server::Handler for TestServer {
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
            reply.accept().await;
            Ok(())
        }

        async fn pty_request(
            &mut self,
            channel: ChannelId,
            term: &str,
            cols: u32,
            rows: u32,
            _: u32,
            _: u32,
            _: &[(Pty, u32)],
            session: &mut Session,
        ) -> Result<(), Self::Error> {
            self.requests
                .lock()
                .unwrap()
                .push(format!("pty:{term}:{cols}x{rows}"));
            if self.reject_pty {
                session.channel_failure(channel)?;
            } else {
                session.channel_success(channel)?;
            }
            Ok(())
        }

        async fn shell_request(
            &mut self,
            channel: ChannelId,
            session: &mut Session,
        ) -> Result<(), Self::Error> {
            self.requests.lock().unwrap().push("shell".into());
            if self.reject_shell {
                session.channel_failure(channel)?;
            } else {
                // Some servers can send output before the request ACK. The
                // negotiation must retain even its initial SGR prefix intact.
                session.data(channel, PROMPT.to_vec())?;
                session.channel_success(channel)?;
            }
            Ok(())
        }
    }

    async fn server(
        reject_pty: bool,
        reject_shell: bool,
    ) -> (
        Handle<ClientHandler>,
        Arc<StdMutex<Vec<String>>>,
        JoinHandle<()>,
    ) {
        let socket = tokio::net::TcpListener::bind(("127.0.0.1", 0))
            .await
            .unwrap();
        let port = socket.local_addr().unwrap().port();
        let requests = Arc::new(StdMutex::new(Vec::new()));
        let mut server = TestServer {
            reject_pty,
            reject_shell,
            requests: requests.clone(),
        };
        let config = server::Config {
            keys: vec![russh::keys::PrivateKey::random(
                &mut rand::rng(),
                russh::keys::Algorithm::Ed25519,
            )
            .unwrap()],
            ..server::Config::default()
        };
        let task = tokio::spawn(async move {
            let _ = server.run_on_socket(Arc::new(config), &socket).await;
        });
        let (mut client, _) = open("127.0.0.1".into(), port, None).await.unwrap();
        assert!(client.authenticate_none("qa").await.unwrap().success());
        (client, requests, task)
    }

    #[tokio::test]
    async fn rejects_denied_pty_before_requesting_a_shell() {
        let (client, requests, server) = server(true, false).await;
        let error = open_terminal_channel(&client, 120, 32).await.unwrap_err();
        assert_eq!(error.to_string(), "ssh.ptyRejected");
        assert_eq!(*requests.lock().unwrap(), ["pty:xterm-256color:120x32"]);
        server.abort();
    }

    #[tokio::test]
    async fn rejects_a_denied_shell_instead_of_showing_a_dead_terminal() {
        let (client, requests, server) = server(false, true).await;
        let error = open_terminal_channel(&client, 80, 24).await.unwrap_err();
        assert_eq!(error.to_string(), "ssh.shellRejected");
        assert_eq!(
            *requests.lock().unwrap(),
            ["pty:xterm-256color:80x24", "shell"]
        );
        server.abort();
    }

    #[tokio::test]
    async fn keeps_early_ansi_bytes_until_attach_and_does_not_replay_on_duplicate_attach() {
        let (client, _, server) = server(false, false).await;
        let (channel, startup) = open_terminal_channel(&client, 80, 24).await.unwrap();
        assert_eq!(startup, PROMPT);
        let (tx, rx) = mpsc::channel(8);
        let (output, mut received) = mpsc::unbounded_channel();
        let task = tokio::spawn(async move {
            pump_terminal(channel, rx, startup, |bytes| {
                output.send(bytes.to_vec()).unwrap();
            })
            .await;
        });
        assert!(
            tokio::time::timeout(Duration::from_millis(30), received.recv())
                .await
                .is_err()
        );
        tx.send(WriterMsg::Attach).await.unwrap();
        assert_eq!(received.recv().await.unwrap(), PROMPT);
        tx.send(WriterMsg::Attach).await.unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(30), received.recv())
                .await
                .is_err()
        );
        tx.send(WriterMsg::Close).await.unwrap();
        task.await.unwrap();
        server.abort();
    }
}
