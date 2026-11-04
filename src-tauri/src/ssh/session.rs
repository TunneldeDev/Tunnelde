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
use tokio::sync::{mpsc, oneshot};
use tokio::task::JoinHandle;

use super::terminal_output::TerminalOutput;
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
    pub host_id: String,
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
    #[serde(default)]
    pub jump_credentials: HashMap<String, HopCredential>,
    #[serde(default = "default_cols")]
    pub cols: u32,
    #[serde(default = "default_rows")]
    pub rows: u32,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct HopCredential {
    pub password: Option<String>,
    pub passphrase: Option<String>,
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
    sequence: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ClosedPayload {
    session_id: String,
    reason: String,
}

#[derive(Debug, Clone)]
pub(super) struct ObservedKey {
    fingerprint: String,
    algorithm: String,
}

pub(crate) struct ClientHandler {
    expected: Option<String>,
    observed: Arc<StdMutex<Option<ObservedKey>>>,
    remote_forwards: Arc<super::forward::RemoteRoutes>,
}

impl client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn server_channel_open_forwarded_tcpip(
        &mut self,
        channel: Channel<client::Msg>,
        connected_address: &str,
        connected_port: u32,
        _originator_address: &str,
        _originator_port: u32,
        reply: client::ChannelOpenHandle,
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        super::forward::remote_channel(
            &self.remote_forwards,
            channel,
            connected_address,
            connected_port,
            reply,
        )
        .await;
        Ok(())
    }

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
    Detach(oneshot::Sender<u64>),
    Data(Vec<u8>),
    Resize { cols: u32, rows: u32 },
    Close,
}

struct SessionHandle {
    info: SessionInfo,
    writer: mpsc::Sender<WriterMsg>,
    task: JoinHandle<()>,
    handle: Arc<Handle<ClientHandler>>,
    _jumps: Vec<Arc<Handle<ClientHandler>>>,
    remote_forwards: Arc<super::forward::RemoteRoutes>,
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

    pub(crate) fn remote_routes(
        &self,
        session_id: &str,
    ) -> AppResult<Arc<super::forward::RemoteRoutes>> {
        self.sessions
            .lock()
            .map_err(|_| AppError::internal("ssh.lock"))?
            .get(session_id)
            .map(|s| s.remote_forwards.clone())
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
                    .filter(|session| !session.handle.is_closed() && !session.task.is_finished())
                    .map(|handle| handle.info.clone())
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn rename_host(&self, host_id: &str, title: &str) {
        if let Ok(mut sessions) = self.sessions.lock() {
            for session in sessions.values_mut() {
                if session.info.host_id == host_id {
                    session.info.title = title.to_owned();
                }
            }
        }
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

    pub async fn detach(&self, session_id: &str) -> AppResult<u64> {
        let writer = self
            .sessions
            .lock()
            .map_err(|_| AppError::internal("ssh.lock"))?
            .get(session_id)
            .map(|session| session.writer.clone())
            .ok_or_else(|| AppError::Ssh("ssh.sessionMissing".into()))?;
        tokio::time::timeout(Duration::from_secs(2), async move {
            let (reply, received) = oneshot::channel();
            writer
                .send(WriterMsg::Detach(reply))
                .await
                .map_err(|_| AppError::Ssh("ssh.sessionMissing".into()))?;
            received
                .await
                .map_err(|_| AppError::Ssh("ssh.sessionMissing".into()))
        })
        .await
        .map_err(|_| AppError::Ssh("ssh.sessionBusy".into()))?
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
    app: &AppHandle,
    host: String,
    port: u16,
    expected: Option<String>,
    transport: Option<crate::network::Stream>,
    proxy: &str,
) -> AppResult<(
    Handle<ClientHandler>,
    ObservedKey,
    Arc<super::forward::RemoteRoutes>,
)> {
    let stream = match transport {
        Some(stream) => stream,
        None => crate::network::tcp(app, &host, port, proxy).await?,
    };
    handshake(stream, expected).await
}

pub(super) async fn handshake(
    stream: crate::network::Stream,
    expected: Option<String>,
) -> AppResult<(
    Handle<ClientHandler>,
    ObservedKey,
    Arc<super::forward::RemoteRoutes>,
)> {
    let observed = Arc::new(StdMutex::new(None));
    let remote_forwards = Arc::new(super::forward::RemoteRoutes::default());
    let handler = ClientHandler {
        expected,
        observed: observed.clone(),
        remote_forwards: remote_forwards.clone(),
    };
    let config = Arc::new(client::Config::default());
    let connected = tokio::time::timeout(
        CONNECT_TIMEOUT,
        client::connect_stream(config, stream, handler),
    )
    .await
    .map_err(|_| AppError::Ssh("ssh.timeout".into()))?
    .map_err(map_ssh_error)?;
    let observed = observed
        .lock()
        .map_err(|_| AppError::internal("ssh.lock"))?
        .clone()
        .ok_or_else(|| AppError::Ssh("ssh.noHostKey".into()))?;
    Ok((connected, observed, remote_forwards))
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

fn emit_data(app: &AppHandle, session_id: &str, sequence: u64, data: &[u8]) {
    let _ = app.emit(
        DATA_EVENT,
        DataPayload {
            session_id: session_id.to_string(),
            data: BASE64.encode(data),
            sequence,
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
    startup: Vec<u8>,
    mut emit: impl FnMut(u64, &[u8]),
) {
    let (mut reader, writer) = channel.split();
    let mut output = TerminalOutput::new(startup);
    loop {
        tokio::select! {
            // Until both frontend listeners exist, SSH's channel queue/window
            // buffers output without losing a prompt's first ANSI bytes.
            incoming = reader.wait(), if output.can_read() => {
                match incoming {
                    Some(ChannelMsg::Data { data }) | Some(ChannelMsg::ExtendedData { data, .. }) => output.receive(&data, &mut emit),
                    Some(ChannelMsg::Close) | None => break,
                    _ => {}
                }
            }
            message = outgoing.recv() => {
                match message {
                    Some(WriterMsg::Attach) => {
                        output.attach(&mut emit);
                    }
                    Some(WriterMsg::Detach(reply)) => {
                        let _ = reply.send(output.detach());
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

async fn probe_host(
    app: &AppHandle,
    host: &Host,
    credentials: &HashMap<String, HopCredential>,
) -> AppResult<HostKeyInfo> {
    let (_, info, _, _) = open_route(app, host, credentials, true).await?;
    Ok(info)
}

pub async fn probe_route(
    app: &AppHandle,
    host_id: &str,
    credentials: HashMap<String, HopCredential>,
) -> AppResult<HostKeyInfo> {
    let host = app
        .state::<AppState>()
        .db
        .with(|conn| db::hosts::find_host(conn, host_id))?;
    probe_host(app, &host, &credentials).await
}

async fn open_route(
    app: &AppHandle,
    host: &Host,
    credentials: &HashMap<String, HopCredential>,
    probing: bool,
) -> AppResult<(
    Handle<ClientHandler>,
    HostKeyInfo,
    Vec<Arc<Handle<ClientHandler>>>,
    Arc<super::forward::RemoteRoutes>,
)> {
    let state = app.state::<AppState>();
    let route = crate::network::route(app, &host.id)?;
    let mut ids = route.jump_hosts;
    ids.push(host.id.clone());
    let mut seen = std::collections::HashSet::new();
    if ids.len() > 9 || ids.iter().any(|id| !seen.insert(id.clone())) {
        return Err(AppError::validation("network.jumpCycle"));
    }
    let mut jumps: Vec<Arc<Handle<ClientHandler>>> = Vec::new();
    for (index, id) in ids.iter().enumerate() {
        let node = if id == &host.id {
            host.clone()
        } else {
            state.db.with(|conn| db::hosts::find_host(conn, id))?
        };
        let known = state
            .db
            .with(|conn| db::known_hosts::find(conn, &node.host, node.port as i64))?;
        let stream = match jumps.last() {
            Some(jump) => Some(Box::pin(
                tokio::time::timeout(
                    CONNECT_TIMEOUT,
                    jump.channel_open_direct_tcpip(&node.host, node.port as u32, "127.0.0.1", 0),
                )
                .await
                .map_err(|_| AppError::Ssh("ssh.timeout".into()))?
                .map_err(map_ssh_error)?
                .into_stream(),
            ) as crate::network::Stream),
            None => None,
        };
        let expected = if probing {
            None
        } else {
            Some(
                known
                    .as_ref()
                    .ok_or_else(|| AppError::Ssh(format!("ssh.hostKeyUntrusted: {}", node.name)))?
                    .fingerprint
                    .clone(),
            )
        };
        let (mut handle, observed, remote_forwards) = open(
            app,
            node.host.clone(),
            node.port,
            expected,
            stream,
            &route.proxy,
        )
        .await?;
        let status = match &known {
            None => HostKeyStatus::Unknown,
            Some(key) if key.fingerprint == observed.fingerprint => HostKeyStatus::Known,
            Some(_) => HostKeyStatus::Changed,
        };
        let info = HostKeyInfo {
            host_id: node.id.clone(),
            fingerprint: observed.fingerprint,
            algorithm: observed.algorithm,
            status,
            known_fingerprint: known.map(|key| key.fingerprint),
        };
        if probing && (status != HostKeyStatus::Known || index + 1 == ids.len()) {
            return Ok((handle, info, jumps, remote_forwards));
        }
        if status != HostKeyStatus::Known {
            return Err(AppError::Ssh(format!("ssh.hostKeyChanged: {}", node.name)));
        }
        if index + 1 == ids.len() {
            return Ok((handle, info, jumps, remote_forwards));
        }
        let credential = credentials.get(&node.id).cloned().unwrap_or_default();
        let request = SshConnectRequest {
            host_id: node.id.clone(),
            password: credential.password,
            passphrase: credential.passphrase,
            jump_credentials: HashMap::new(),
            cols: 120,
            rows: 32,
        };
        tokio::time::timeout(CONNECT_TIMEOUT, authenticate(&mut handle, &node, &request))
            .await
            .map_err(|_| AppError::Ssh("ssh.timeout".into()))??;
        jumps.push(Arc::new(handle));
    }
    Err(AppError::validation("network.invalid"))
}

pub async fn trust_route(
    app: &AppHandle,
    host_id: &str,
    fingerprint: &str,
    expected_host_id: Option<&str>,
    credentials: HashMap<String, HopCredential>,
) -> AppResult<HostKeyInfo> {
    let state = app.state::<AppState>();
    let host = state.db.with(|conn| db::hosts::find_host(conn, host_id))?;
    let info = probe_host(app, &host, &credentials).await?;
    // Record only the key the user actually reviewed, never a newly observed key.
    if info.fingerprint != fingerprint || info.host_id != expected_host_id.unwrap_or(host_id) {
        return Err(AppError::Ssh("ssh.hostKeyChanged".into()));
    }

    let approved = state
        .db
        .with(|conn| db::hosts::find_host(conn, &info.host_id))?;
    state.db.with(|conn| {
        db::known_hosts::upsert(
            conn,
            &approved.host,
            approved.port as i64,
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
    let (mut handle, _observed, jumps, remote_forwards) =
        open_route(&app, &host, &request.jump_credentials, false).await?;

    tokio::time::timeout(CONNECT_TIMEOUT, authenticate(&mut handle, &host, &request))
        .await
        .map_err(|_| AppError::Ssh("ssh.timeout".into()))??;

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
        pump_terminal(channel, rx, startup, |sequence, data| {
            emit_data(&task_app, &task_session, sequence, data)
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
            state.forwards.stop_session(&task_session);
            state.mounts.stop_session(&task_session).await;
            state.ssh.remove(&task_session);
            state.monitor.forget(&task_session);
        }
    });

    state.ssh.insert(SessionHandle {
        _jumps: jumps,
        remote_forwards,
        info: info.clone(),
        writer: tx,
        task,
        handle: shared_handle,
    });

    tracing::info!(host = %host.name, session = %session_id, "ssh session opened");
    let runner_app = app.clone();
    tokio::spawn(async move {
        crate::ssh::files::durable::on_reconnect(&runner_app).await;
        crate::plugins::runners::on_reconnect(&runner_app).await;
    });
    Ok(info)
}

pub fn disconnect(app: &AppHandle, session_id: &str) -> AppResult<()> {
    let state = app.state::<AppState>();
    state.forwards.stop_session(session_id);
    let cleanup_app = app.clone();
    let cleanup_session = session_id.to_owned();
    tauri::async_runtime::spawn(async move {
        cleanup_app
            .state::<AppState>()
            .mounts
            .stop_session(&cleanup_session)
            .await;
    });
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

        async fn data(
            &mut self,
            channel: ChannelId,
            data: &[u8],
            session: &mut Session,
        ) -> Result<(), Self::Error> {
            session.data(channel, data.to_vec())?;
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
        let stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .unwrap();
        let (mut client, _, _) = handshake(Box::pin(stream), None).await.unwrap();
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
            pump_terminal(channel, rx, startup, |_, bytes| {
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

    #[tokio::test]
    async fn detaches_without_closing_the_pty_and_replays_background_output_on_attach() {
        let (client, _, server) = server(false, false).await;
        let (channel, startup) = open_terminal_channel(&client, 80, 24).await.unwrap();
        let (tx, rx) = mpsc::channel(8);
        let (output, mut received) = mpsc::unbounded_channel();
        let task = tokio::spawn(async move {
            pump_terminal(channel, rx, startup, |sequence, bytes| {
                output.send((sequence, bytes.to_vec())).unwrap();
            })
            .await;
        });
        tx.send(WriterMsg::Attach).await.unwrap();
        assert_eq!(received.recv().await.unwrap(), (1, PROMPT.to_vec()));
        let (reply, detached) = oneshot::channel();
        tx.send(WriterMsg::Detach(reply)).await.unwrap();
        assert_eq!(detached.await.unwrap(), 1);
        let background = "\x1b[33m后台任务已完成\x1b[0m\r\n".as_bytes().to_vec();
        tx.send(WriterMsg::Data(background.clone())).await.unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(50), received.recv())
                .await
                .is_err()
        );
        let (reply, detached) = oneshot::channel();
        tx.send(WriterMsg::Detach(reply)).await.unwrap();
        assert_eq!(detached.await.unwrap(), 1);
        tx.send(WriterMsg::Attach).await.unwrap();
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(2), received.recv())
                .await
                .unwrap()
                .unwrap(),
            (2, background)
        );
        tx.send(WriterMsg::Data(b"still alive".to_vec()))
            .await
            .unwrap();
        assert_eq!(
            tokio::time::timeout(Duration::from_secs(2), received.recv())
                .await
                .unwrap()
                .unwrap(),
            (3, b"still alive".to_vec())
        );
        tx.send(WriterMsg::Close).await.unwrap();
        task.await.unwrap();
        server.abort();
    }
}
