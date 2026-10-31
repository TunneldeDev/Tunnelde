// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use russh::client::{self, Handle};
use russh::keys::{HashAlg, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use russh::ChannelMsg;
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
    let state = app.state::<AppState>();
    let host = state
        .db
        .with(|conn| db::hosts::find_host(conn, &request.host_id))?;
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

    let channel = handle.channel_open_session().await.map_err(map_ssh_error)?;
    // Color-aware tools look at these first; servers that do not accept them
    // simply ignore the request.
    for (name, value) in [
        ("TERM", TERM),
        ("LANG", "en_US.UTF-8"),
        ("COLORTERM", "truecolor"),
        ("TERM_PROGRAM", "Tunnelde"),
    ] {
        let _ = channel.set_env(false, name, value).await;
    }
    channel
        .request_pty(true, TERM, request.cols, request.rows, 0, 0, &[])
        .await
        .map_err(map_ssh_error)?;
    channel.request_shell(true).await.map_err(map_ssh_error)?;

    let (mut reader, writer) = channel.split();

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
    let (tx, mut rx) = mpsc::channel::<WriterMsg>(64);
    let task_app = app.clone();
    let task_session = session_id.clone();

    let task_handle = Arc::clone(&shared_handle);
    let task = tokio::spawn(async move {
        let _session = task_handle;
        loop {
            tokio::select! {
                incoming = reader.wait() => {
                    match incoming {
                        Some(ChannelMsg::Data { data }) => emit_data(&task_app, &task_session, &data),
                        Some(ChannelMsg::ExtendedData { data, .. }) => {
                            emit_data(&task_app, &task_session, &data)
                        }
                        Some(ChannelMsg::Close) | None => break,
                        _ => {}
                    }
                }
                outgoing = rx.recv() => {
                    match outgoing {
                        Some(WriterMsg::Data(bytes)) => {
                            if writer.data_bytes(bytes).await.is_err() {
                                break;
                            }
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
    Ok(info)
}

pub fn disconnect(app: &AppHandle, session_id: &str) -> AppResult<()> {
    let state = app.state::<AppState>();
    state.ssh.disconnect(session_id);
    Ok(())
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
