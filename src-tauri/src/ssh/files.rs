use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use russh_sftp::client::SftpSession;
use russh_sftp::protocol::{OpenFlags, StatusCode};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};

use crate::error::{AppError, AppResult};
use crate::state::AppState;

mod artifacts;
pub mod bandwidth;
mod compressed;
pub mod durable;
mod range_io;
mod scheduler;
pub mod search;
mod segments;

pub const TRANSFER_EVENT: &str = "sftp://transfer";

const CHUNK: usize = 64 * 1024;
const PROGRESS_STEP: u64 = 256 * 1024;
const CANCELLED: &str = "sftp.cancelled";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_hidden: bool,
    pub size: u64,
    pub modified: Option<i64>,
    pub permissions: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Listing {
    pub path: String,
    pub entries: Vec<FileEntry>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TransferStatus {
    Running,
    Done,
    Failed,
    Cancelled,
    Paused,
    CleanupPending,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransferEvent {
    pub id: String,
    pub direction: &'static str,
    pub name: String,
    pub transferred: u64,
    pub total: u64,
    pub status: TransferStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phase: Option<&'static str>,
    pub error: Option<String>,
}

#[derive(Default)]
pub struct TransferRegistry {
    inner: std::sync::Mutex<TransferState>,
    pub bandwidth: Arc<bandwidth::Controller>,
    scheduler: scheduler::Scheduler,
}

#[derive(Default)]
struct TransferState {
    active: std::collections::HashMap<String, ActiveTransfer>,
    completed: std::collections::VecDeque<CompletedTransfer>,
    paused: std::collections::HashSet<String>,
}

struct ActiveTransfer {
    cancel: Arc<AtomicBool>,
    owner: Option<TransferOwner>,
    event: TransferEvent,
}

struct CompletedTransfer {
    plugin_id: String,
    generation: u64,
    event: TransferEvent,
}

struct TransferOwner {
    plugin_id: String,
    generation: u64,
    cancelled: tokio::sync::watch::Sender<bool>,
}

impl ActiveTransfer {
    fn cancel(&self) {
        self.cancel.store(true, Ordering::SeqCst);
        if let Some(owner) = &self.owner {
            owner.cancelled.send_replace(true);
        }
    }
}

impl TransferRegistry {
    fn release(&self, id: &str) {
        if let Ok(mut state) = self.inner.lock() {
            state.active.remove(id);
            state.paused.remove(id);
            self.bandwidth.remove(id);
        }
    }
    pub fn is_active(&self, id: &str) -> bool {
        self.inner
            .lock()
            .map(|s| s.active.contains_key(id))
            .unwrap_or(false)
    }
    pub fn pause(&self, id: &str) {
        if let Ok(mut state) = self.inner.lock() {
            if let Some(t) = state.active.get(id) {
                if !t.cancel.load(Ordering::SeqCst) {
                    t.cancel();
                    state.paused.insert(id.into());
                }
            }
        }
    }
    fn take_paused(&self, id: &str) -> bool {
        self.inner
            .lock()
            .map(|mut s| s.paused.remove(id))
            .unwrap_or(false)
    }

    fn register(
        &self,
        id: &str,
        flag: Arc<AtomicBool>,
        owner: Option<TransferOwner>,
    ) -> AppResult<()> {
        let mut state = self
            .inner
            .lock()
            .map_err(|_| AppError::internal("sftp.transferRegistry"))?;
        if state.active.contains_key(id) {
            return Err(AppError::validation("sftp.transferBusy"));
        }
        if owner.as_ref().is_some_and(|owner| {
            state
                .active
                .values()
                .filter(|transfer| {
                    transfer
                        .owner
                        .as_ref()
                        .is_some_and(|existing| existing.plugin_id == owner.plugin_id)
                })
                .count()
                >= 8
        }) {
            return Err(AppError::validation("plugin.api.transferBusy"));
        }
        state.active.insert(
            id.to_string(),
            ActiveTransfer {
                cancel: flag,
                owner,
                event: TransferEvent {
                    id: id.into(),
                    direction: "transfer",
                    name: id.into(),
                    transferred: 0,
                    total: 0,
                    status: TransferStatus::Running,
                    phase: None,
                    error: None,
                },
            },
        );
        self.bandwidth.register(id);
        Ok(())
    }

    fn update(&self, event: &TransferEvent) {
        if let Ok(mut state) = self.inner.lock() {
            if let Some(transfer) = state.active.get_mut(&event.id) {
                transfer.event = event.clone();
            }
        }
    }

    fn complete(&self, mut event: TransferEvent) -> TransferEvent {
        if let Ok(mut state) = self.inner.lock() {
            if let Some(transfer) = state.active.remove(&event.id) {
                self.bandwidth.remove(&event.id);
                if event.status == TransferStatus::Cancelled {
                    event.transferred = event.transferred.max(transfer.event.transferred);
                    event.total = event.total.max(transfer.event.total);
                }
                if let Some(owner) = transfer.owner {
                    state.completed.push_back(CompletedTransfer {
                        plugin_id: owner.plugin_id,
                        generation: owner.generation,
                        event: event.clone(),
                    });
                    while state.completed.len() > 256 {
                        state.completed.pop_front();
                    }
                }
            }
        }
        event
    }

    pub fn cancel(&self, id: &str) {
        if let Ok(mut state) = self.inner.lock() {
            state.paused.remove(id);
            if let Some(transfer) = state.active.get(id) {
                transfer.cancel();
            }
        }
    }

    /// Plugins can cancel only transfers created by their current runtime.
    pub fn cancel_owned(&self, id: &str, plugin_id: &str, generation: u64) -> bool {
        let Ok(state) = self.inner.lock() else {
            return false;
        };
        let Some(transfer) = state.active.get(id) else {
            return false;
        };
        if transfer
            .owner
            .as_ref()
            .is_some_and(|owner| owner.plugin_id == plugin_id && owner.generation == generation)
        {
            transfer.cancel();
            true
        } else {
            false
        }
    }

    pub fn status_owned(
        &self,
        id: &str,
        plugin_id: &str,
        generation: u64,
    ) -> Option<TransferEvent> {
        let state = self.inner.lock().ok()?;
        if let Some(transfer) = state.active.get(id) {
            return transfer
                .owner
                .as_ref()
                .filter(|owner| owner.plugin_id == plugin_id && owner.generation == generation)
                .map(|_| transfer.event.clone());
        }
        state
            .completed
            .iter()
            .rev()
            .find(|transfer| {
                transfer.event.id == id
                    && transfer.plugin_id == plugin_id
                    && transfer.generation == generation
            })
            .map(|transfer| transfer.event.clone())
    }

    /// An exited process must not leave background work running. Matching the
    /// generation prevents an older process from cancelling its replacement.
    pub fn cancel_plugin(&self, plugin_id: &str, generation: u64) {
        if let Ok(state) = self.inner.lock() {
            for transfer in state.active.values() {
                if transfer.owner.as_ref().is_some_and(|owner| {
                    owner.plugin_id == plugin_id && owner.generation == generation
                }) {
                    transfer.cancel();
                }
            }
        }
    }
}

/// One side of a transfer: a local folder or a folder on an SSH session.
#[derive(Debug, Clone)]
pub struct Endpoint {
    pub session: Option<String>,
    pub path: String,
}

impl Endpoint {
    fn child(&self, path: String) -> Self {
        Self {
            session: self.session.clone(),
            path,
        }
    }

    fn join(&self, name: &str) -> String {
        if self.session.is_some() {
            join_remote(&self.path, name)
        } else {
            display_path(&Path::new(&self.path).join(name))
        }
    }
}

fn millis(time: SystemTime) -> Option<i64> {
    time.duration_since(UNIX_EPOCH)
        .ok()
        .map(|value| value.as_millis() as i64)
}

fn sort_entries(entries: &mut [FileEntry]) {
    entries.sort_by(|left, right| {
        right
            .is_dir
            .cmp(&left.is_dir)
            .then_with(|| left.name.to_lowercase().cmp(&right.name.to_lowercase()))
    });
}

fn local_hidden(name: &str, metadata: &std::fs::Metadata) -> bool {
    if name.starts_with('.') {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x2 != 0
    }
    #[cfg(not(windows))]
    {
        let _ = metadata;
        false
    }
}

fn map_sftp(error: russh_sftp::client::error::Error) -> AppError {
    AppError::Ssh(format!("sftp.error: {error}"))
}

fn display_path(path: &Path) -> String {
    let text = path.to_string_lossy().into_owned();
    text.strip_prefix(r"\\?\")
        .map(str::to_string)
        .unwrap_or(text)
}

fn file_name_of(path: &str) -> String {
    path.trim_end_matches(['/', '\\'])
        .rsplit(['/', '\\'])
        .next()
        .filter(|value| !value.is_empty())
        .unwrap_or(path)
        .to_string()
}

pub fn home_dir() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_else(|| PathBuf::from("."))
}

pub(crate) async fn session(app: &AppHandle, session_id: &str) -> AppResult<SftpSession> {
    session_with_config(app, session_id, russh_sftp::client::Config::default()).await
}

async fn session_with_config(
    app: &AppHandle,
    session_id: &str,
    config: russh_sftp::client::Config,
) -> AppResult<SftpSession> {
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        let handle = app.state::<AppState>().ssh.handle(session_id)?;
        let channel = handle
            .channel_open_session()
            .await
            .map_err(|error| AppError::Ssh(format!("sftp.channel: {error}")))?;
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|error| AppError::Ssh(format!("sftp.subsystem: {error}")))?;
        SftpSession::new_with_config(channel.into_stream(), config)
            .await
            .map_err(map_sftp)
    })
    .await
    .map_err(|_| AppError::Ssh("sftp.transferTimedOut".into()))?
}

fn requested_directory(home: &str, input: Option<&str>) -> AppResult<String> {
    let input = input
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(".");
    if input.len() > 32768 || input.contains('\0') {
        return Err(AppError::validation("plugin.tools.invalidPath"));
    }
    if matches!(input, "." | "~") {
        Ok(home.into())
    } else if let Some(relative) = input.strip_prefix("~/") {
        Ok(format!("{}/{relative}", home.trim_end_matches('/')))
    } else if input.starts_with('/') {
        Ok(input.into())
    } else {
        Ok(format!("{}/{input}", home.trim_end_matches('/')))
    }
}

pub async fn remote_resolve_directory(
    app: &AppHandle,
    session_id: &str,
    path: Option<String>,
) -> AppResult<serde_json::Value> {
    let sftp = session(app, session_id).await?;
    let result = async {
        let home = sftp.canonicalize(".").await.map_err(map_sftp)?;
        let requested = requested_directory(&home, path.as_deref())?;
        let path = sftp.canonicalize(requested).await.map_err(map_sftp)?;
        if !sftp.metadata(&path).await.map_err(map_sftp)?.is_dir() {
            return Err(AppError::validation("plugin.tools.invalidPath"));
        }
        Ok(serde_json::json!({ "home": home, "path": path }))
    }
    .await;
    let _ = sftp.close().await;
    result
}

pub async fn remote_list(
    app: &AppHandle,
    session_id: &str,
    path: Option<String>,
) -> AppResult<Listing> {
    let sftp = session(app, session_id).await?;
    let requested = path
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| ".".to_string());
    let resolved = sftp
        .canonicalize(requested.clone())
        .await
        .unwrap_or(requested);

    let directory = sftp.read_dir(resolved.clone()).await.map_err(map_sftp)?;
    let mut entries: Vec<FileEntry> = directory
        .map(|entry| {
            let metadata = entry.metadata();
            let name = entry.file_name();
            FileEntry {
                is_hidden: name.starts_with('.'),
                name,
                path: entry.path(),
                is_dir: metadata.is_dir(),
                size: metadata.len(),
                modified: metadata.modified().ok().and_then(millis),
                permissions: metadata.permissions,
            }
        })
        .collect();
    sort_entries(&mut entries);
    let _ = sftp.close().await;

    Ok(Listing {
        path: resolved,
        entries,
    })
}

pub fn local_list(path: Option<String>) -> AppResult<Listing> {
    let requested = path
        .filter(|value| !value.trim().is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(home_dir);
    let resolved = requested.canonicalize().unwrap_or(requested);

    let mut entries = Vec::new();
    for entry in std::fs::read_dir(&resolved)? {
        let Ok(entry) = entry else { continue };
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        entries.push(FileEntry {
            is_hidden: local_hidden(&name, &metadata),
            name,
            path: display_path(&entry.path()),
            is_dir: metadata.is_dir(),
            size: metadata.len(),
            modified: metadata.modified().ok().and_then(millis),
            permissions: None,
        });
    }
    sort_entries(&mut entries);

    Ok(Listing {
        path: display_path(&resolved),
        entries,
    })
}

pub async fn remote_mkdir(app: &AppHandle, session_id: &str, path: String) -> AppResult<()> {
    let sftp = session(app, session_id).await?;
    sftp.create_dir(path).await.map_err(map_sftp)?;
    let _ = sftp.close().await;
    Ok(())
}

pub async fn remote_rename(
    app: &AppHandle,
    session_id: &str,
    from: String,
    to: String,
    overwrite: bool,
) -> AppResult<()> {
    let sftp = session(app, session_id).await?;
    let result = async {
        check_remote_destination(&sftp, &from, &to, overwrite).await?;
        if overwrite && remote_exists(&sftp, &to).await? {
            return remote_replace(app, session_id, &from, &to).await;
        }
        sftp.rename(from, to).await.map_err(map_sftp)
    }
    .await;
    let _ = sftp.close().await;
    result
}

// OpenSSH's extension maps to the server's atomic rename operation. In
// particular, never delete the destination as a workaround for SFTP v3.
async fn remote_replace(app: &AppHandle, session_id: &str, from: &str, to: &str) -> AppResult<()> {
    use russh_sftp::client::RawSftpSession;
    tokio::time::timeout(std::time::Duration::from_secs(10), async {
        let handle = app.state::<AppState>().ssh.handle(session_id)?;
        let channel = handle
            .channel_open_session()
            .await
            .map_err(|error| AppError::Ssh(format!("sftp.channel: {error}")))?;
        channel
            .request_subsystem(true, "sftp")
            .await
            .map_err(|error| AppError::Ssh(format!("sftp.subsystem: {error}")))?;
        let raw = RawSftpSession::new(channel.into_stream());
        let result = posix_replace(&raw, from, to).await;
        let _ = raw.close_session();
        result
    })
    .await
    .map_err(|_| AppError::Ssh("sftp.transferTimedOut".into()))?
}

async fn posix_replace(
    raw: &russh_sftp::client::RawSftpSession,
    from: &str,
    to: &str,
) -> AppResult<()> {
    use russh_sftp::protocol::Packet;
    let version = raw.init().await.map_err(map_sftp)?;
    if version
        .extensions
        .get("posix-rename@openssh.com")
        .map(String::as_str)
        != Some("1")
    {
        return Err(AppError::validation("sftp.overwriteUnsupported"));
    }
    let mut payload = Vec::new();
    for path in [from, to] {
        let length = u32::try_from(path.len())
            .map_err(|_| AppError::validation("plugin.tools.invalidPath"))?;
        payload.extend_from_slice(&length.to_be_bytes());
        payload.extend_from_slice(path.as_bytes());
    }
    match raw
        .extended("posix-rename@openssh.com", payload)
        .await
        .map_err(map_sftp)?
    {
        Packet::Status(status) if status.status_code == StatusCode::Ok => Ok(()),
        Packet::Status(status) => Err(map_sftp(russh_sftp::client::error::Error::Status(status))),
        _ => Err(map_sftp(russh_sftp::client::error::Error::UnexpectedPacket)),
    }
}

pub async fn remote_delete(
    app: &AppHandle,
    session_id: &str,
    path: String,
    _is_dir: bool,
) -> AppResult<()> {
    let sftp = session(app, session_id).await?;
    remove_remote_entry(&sftp, &path).await?;
    let _ = sftp.close().await;
    Ok(())
}

pub fn local_mkdir(path: String) -> AppResult<()> {
    std::fs::create_dir(Path::new(&path))?;
    Ok(())
}

pub fn local_create_file(path: String) -> AppResult<()> {
    std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(Path::new(&path))?;
    Ok(())
}

pub async fn remote_create_file(app: &AppHandle, session_id: &str, path: String) -> AppResult<()> {
    let sftp = session(app, session_id).await?;
    let result = sftp
        .open_with_flags(
            &path,
            OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::EXCLUDE,
        )
        .await
        .map_err(map_sftp);
    if let Ok(mut file) = result {
        let result = file.shutdown().await.map_err(AppError::from);
        let _ = sftp.close().await;
        return result;
    }
    let _ = sftp.close().await;
    result.map(|_| ())
}

pub fn local_rename(from: String, to: String, overwrite: bool) -> AppResult<()> {
    check_local_destination(Path::new(&from), Path::new(&to), overwrite)?;
    if Path::new(&to).is_dir() {
        copy_local_entry(Path::new(&from), Path::new(&to), overwrite)?;
        return remove_local_entry(Path::new(&from));
    }
    std::fs::rename(from, to)?;
    Ok(())
}

pub fn local_delete(path: String, _is_dir: bool) -> AppResult<()> {
    remove_local_entry(&PathBuf::from(path))
}

fn emit(app: &AppHandle, event: TransferEvent) {
    app.state::<AppState>().transfers.update(&event);
    let _ = app.emit(TRANSFER_EVENT, event);
}

fn phase(app: &AppHandle, id: &str, phase: &'static str) {
    let event = app
        .state::<AppState>()
        .transfers
        .inner
        .lock()
        .ok()
        .and_then(|state| state.active.get(id).map(|transfer| transfer.event.clone()));
    if let Some(mut event) = event {
        event.phase = Some(phase);
        emit(app, event);
    }
}

fn progress(app: &AppHandle, id: &str, name: &str, transferred: u64, total: u64) {
    emit(
        app,
        TransferEvent {
            id: id.into(),
            direction: "transfer",
            name: name.into(),
            transferred,
            total,
            status: TransferStatus::Running,
            phase: None,
            error: None,
        },
    );
}

enum Outcome {
    Done(u64),
    Cancelled(u64),
    Failed(u64, String),
}

impl Outcome {
    fn from_result(result: AppResult<()>, transferred: u64, cancel: &AtomicBool) -> Self {
        match result {
            Ok(()) => Self::Done(transferred),
            Err(_) if cancel.load(Ordering::SeqCst) => Self::Cancelled(transferred),
            Err(error) => Self::Failed(transferred, error.to_string()),
        }
    }
}

async fn finish(app: &AppHandle, id: &str, name: &str, outcome: Outcome) {
    let state = app.state::<AppState>();
    let event = match outcome {
        Outcome::Done(total) => TransferEvent {
            id: id.into(),
            direction: "transfer",
            name: name.into(),
            transferred: total,
            total,
            status: TransferStatus::Done,
            phase: None,
            error: None,
        },
        Outcome::Cancelled(transferred) => TransferEvent {
            id: id.into(),
            direction: "transfer",
            name: name.into(),
            transferred,
            total: 0,
            status: TransferStatus::Cancelled,
            phase: None,
            error: None,
        },
        Outcome::Failed(transferred, error) => TransferEvent {
            id: id.into(),
            direction: "transfer",
            name: name.into(),
            transferred,
            total: 0,
            status: TransferStatus::Failed,
            phase: None,
            error: Some(error),
        },
    };
    let mut event = event;
    if event.status == TransferStatus::Cancelled && state.transfers.take_paused(id) {
        event.status = TransferStatus::Paused;
    }
    if let Ok(mut row) = durable::Journal::get(app, id) {
        if event.status == TransferStatus::Cancelled {
            row.status = "cancelling".into();
            row.error = Some("sftp.cancelCleanupFailed".into());
            if let Err(error) = durable::Journal::upsert(app, row.clone()) {
                tracing::error!(%error, "Cannot persist cancellation intent");
            }
            phase(app, id, "cleaning");
            let cleaned = tokio::time::timeout(
                std::time::Duration::from_secs(5),
                durable::cleanup_artifacts(app, &row),
            )
            .await;
            match cleaned {
                Ok(Ok(())) => {}
                Ok(Err(error)) => {
                    tracing::warn!(%error, transfer_id=id, "Cancelled transfer cleanup must be retried");
                    event.error = Some("sftp.cancelCleanupFailed".into());
                    event.status = TransferStatus::CleanupPending;
                }
                Err(_) => {
                    tracing::warn!(transfer_id = id, "Cancelled transfer cleanup timed out");
                    event.error = Some("sftp.cancelCleanupFailed".into());
                    event.status = TransferStatus::CleanupPending;
                }
            }
        }
        if matches!(
            event.status,
            TransferStatus::Cancelled
                | TransferStatus::Paused
                | TransferStatus::Failed
                | TransferStatus::CleanupPending
        ) {
            event.transferred = event.transferred.max(row.transferred);
        }
        row.status = match event.status {
            TransferStatus::Running => "running",
            TransferStatus::Done => "done",
            TransferStatus::Cancelled => "cancelled",
            TransferStatus::Paused => "paused",
            TransferStatus::Failed => "failed",
            TransferStatus::CleanupPending => "cleanupPending",
        }
        .into();
        row.transferred = event.transferred;
        row.total = row.total.max(event.total);
        row.error = event.error.clone();
        row.updated_at = crate::models::now_ms();
        if let Err(error) = durable::Journal::upsert(app, row) {
            tracing::error!(%error,"Cannot persist transfer completion");
        }
    }
    if let Ok(row) = durable::Journal::get(app, id) {
        event.total = event.total.max(row.total);
    }
    let retry_cleanup = event.status == TransferStatus::CleanupPending;
    let event = state.transfers.complete(event);
    emit(app, event);
    if retry_cleanup {
        let cleanup_app = app.clone();
        tauri::async_runtime::spawn(async move {
            durable::on_reconnect(&cleanup_app).await;
        });
    }
}

/// Copies one endpoint onto another, whatever the two sides are: disk to disk,
/// disk to a server, server to disk or between two servers. Folders are walked
/// recursively and any single failure aborts the whole operation.
pub fn spawn_transfer(
    app: AppHandle,
    from: Endpoint,
    to: Endpoint,
    remove_source: bool,
    overwrite: bool,
) -> AppResult<String> {
    spawn_transfer_inner(app, from, to, remove_source, overwrite, None)
}

pub(crate) fn spawn_plugin_transfer(
    app: AppHandle,
    from: Endpoint,
    to: Endpoint,
    overwrite: bool,
    owner: crate::plugins::security::Lease,
) -> AppResult<String> {
    // Plugin transfers copy only; deleting the source requires a separate,
    // explicitly permitted file operation.
    spawn_transfer_inner(app, from, to, false, overwrite, Some(owner))
}

fn spawn_transfer_inner(
    app: AppHandle,
    from: Endpoint,
    to: Endpoint,
    remove_source: bool,
    overwrite: bool,
    owner: Option<crate::plugins::security::Lease>,
) -> AppResult<String> {
    if from.session == to.session && from.path == to.path {
        return Err(AppError::validation("sftp.samePath"));
    }

    let id = uuid::Uuid::new_v4().to_string();
    if owner.is_none() {
        let sessions = app.state::<AppState>().ssh.list();
        let host = |id: &Option<String>| {
            id.as_ref()
                .and_then(|id| sessions.iter().find(|s| &s.id == id))
                .map(|s| s.host_id.clone())
        };
        let address = |id: &Option<String>| {
            id.as_ref()
                .and_then(|id| sessions.iter().find(|s| &s.id == id))
                .map(|s| s.address.clone())
        };
        durable::Journal::upsert(
            &app,
            durable::DurableTransfer {
                id: id.clone(),
                direction: "transfer".into(),
                name: file_name_of(&from.path),
                from_session: from.session.clone(),
                from_host_id: host(&from.session),
                from_address: address(&from.session),
                from_path: from.path.clone(),
                to_session: to.session.clone(),
                to_host_id: host(&to.session),
                to_address: address(&to.session),
                to_path: to.path.clone(),
                remove_source,
                deleting_source: false,
                overwrite,
                transferred: 0,
                total: 0,
                status: "running".into(),
                phase: None,
                error: None,
                updated_at: crate::models::now_ms(),
            },
        )?;
    }
    let name = file_name_of(&from.path);
    let cancel = Arc::new(AtomicBool::new(false));
    let (cancel_sender, mut cancelled) = tokio::sync::watch::channel(false);
    let transfer_owner = owner.as_ref().map(|lease| TransferOwner {
        plugin_id: lease.id.clone(),
        generation: lease.generation,
        cancelled: cancel_sender,
    });
    app.state::<AppState>()
        .transfers
        .register(&id, cancel.clone(), transfer_owner)?;
    progress(&app, &id, &name, 0, 0);
    if owner.is_none() {
        let _ = app.emit("sftp://changed", ());
    }

    let transfer_id = id.clone();
    tauri::async_runtime::spawn(async move {
        let app_handle = app.clone();
        let operation = run(
            &app_handle,
            &from,
            &to,
            &transfer_id,
            &name,
            &cancel,
            TransferOptions {
                remove_source,
                overwrite,
                durable: owner.is_none(),
                resuming: false,
            },
        );
        let plugin_transfer = owner.is_some();
        let outcome = if let Some(owner) = owner {
            let state = app_handle.state::<AppState>();
            guard_plugin_transfer(&state.plugins.security, &owner, &mut cancelled, operation).await
        } else {
            operation.await
        };
        finish(&app_handle, &transfer_id, &name, outcome).await;
        if plugin_transfer {
            let _ = app_handle.emit(
                "plugin://domain-changed",
                serde_json::json!({"domain":"files","sessionId":to.session}),
            );
        }
    });

    Ok(id)
}

pub(crate) fn resume_transfer(
    app: AppHandle,
    from: Endpoint,
    to: Endpoint,
    row: durable::DurableTransfer,
) -> AppResult<()> {
    if matches!(
        row.status.as_str(),
        "done" | "cancelled" | "cancelling" | "cleanupPending"
    ) {
        return Err(AppError::validation("sftp.transferAlreadyComplete"));
    }
    let cancel = Arc::new(AtomicBool::new(false));
    let id = row.id.clone();
    let name = row.name.clone();
    let app2 = app.clone();
    app.state::<AppState>()
        .transfers
        .register(&id, cancel.clone(), None)?;
    let mut row = row;
    row.from_session = from.session.clone();
    row.to_session = to.session.clone();
    row.status = "running".into();
    row.error = None;
    row.updated_at = crate::models::now_ms();
    if let Err(error) = durable::Journal::upsert(&app, row.clone()) {
        app.state::<AppState>().transfers.release(&id);
        return Err(error);
    }
    tauri::async_runtime::spawn(async move {
        let out = run(
            &app2,
            &from,
            &to,
            &id,
            &name,
            &cancel,
            TransferOptions {
                remove_source: row.remove_source,
                overwrite: row.overwrite,
                durable: true,
                resuming: true,
            },
        )
        .await;
        finish(&app2, &id, &name, out).await;
    });
    Ok(())
}

async fn guard_plugin_transfer(
    security: &crate::plugins::security::PluginSecurity,
    owner: &crate::plugins::security::Lease,
    cancelled: &mut tokio::sync::watch::Receiver<bool>,
    operation: impl std::future::Future<Output = Outcome>,
) -> Outcome {
    if *cancelled.borrow() {
        return Outcome::Cancelled(0);
    }
    tokio::select! {
        biased;
        _ = cancelled.changed() => Outcome::Cancelled(0),
        result = security.guard(owner, async { Ok(operation.await) }) => {
            result.unwrap_or(Outcome::Cancelled(0))
        }
    }
}

struct Meter<'a> {
    app: &'a AppHandle,
    id: &'a str,
    name: &'a str,
    transferred: u64,
    total: u64,
    last: u64,
    last_update: std::time::Instant,
    settings: crate::settings::Settings,
    data_channels: Option<range_io::Sessions>,
}

impl<'a> Meter<'a> {
    fn throttle(&self) -> bandwidth::Throttle {
        bandwidth::Throttle {
            controller: self.app.state::<AppState>().transfers.bandwidth.clone(),
            id: self.id.into(),
        }
    }

    fn new(app: &'a AppHandle, id: &'a str, name: &'a str, total: u64) -> Self {
        Self {
            app,
            id,
            name,
            transferred: 0,
            total,
            last: 0,
            last_update: std::time::Instant::now(),
            settings: app.state::<AppState>().settings(),
            data_channels: None,
        }
    }

    fn add(&mut self, bytes: u64) {
        self.transferred += bytes;
        if (self.transferred - self.last >= PROGRESS_STEP
            && self.last_update.elapsed() >= std::time::Duration::from_millis(100))
            || (self.transferred != self.last
                && self.last_update.elapsed() >= std::time::Duration::from_millis(250))
            || self.transferred >= self.total
        {
            self.last = self.transferred;
            self.last_update = std::time::Instant::now();
            if let Ok(mut row) = durable::Journal::get(self.app, self.id) {
                row.transferred = self.transferred;
                row.total = self.total;
                row.updated_at = crate::models::now_ms();
                if let Err(error) = durable::Journal::upsert(self.app, row) {
                    tracing::error!(%error,"Cannot persist transfer progress");
                }
            }
            progress(self.app, self.id, self.name, self.transferred, self.total);
        }
    }

    fn retain(&mut self, bytes: u64) -> AppResult<()> {
        self.transferred = bytes;
        self.last = bytes;
        if let Ok(mut row) = durable::Journal::get(self.app, self.id) {
            row.transferred = bytes;
            durable::Journal::upsert(self.app, row)?;
        }
        progress(self.app, self.id, self.name, bytes, self.total);
        Ok(())
    }
}

enum Reader {
    Local(tokio::fs::File),
    Remote(Box<russh_sftp::client::fs::File>),
}

/// Check cancellation while waiting for a stalled socket, including verification.
async fn interruptible<T>(
    cancel: Option<&AtomicBool>,
    operation: impl std::future::Future<Output = AppResult<T>>,
) -> AppResult<T> {
    tokio::pin!(operation);
    let mut tick = tokio::time::interval(std::time::Duration::from_millis(40));
    loop {
        tokio::select! {
            biased;
            _ = tick.tick() => {
                if cancel.is_some_and(|flag| flag.load(Ordering::SeqCst)) {
                    return Err(AppError::Ssh(CANCELLED.into()));
                }
            }
            result = &mut operation => return result,
        }
    }
}

impl Reader {
    async fn seek(&mut self, offset: u64) -> AppResult<()> {
        match self {
            Reader::Local(file) => file.seek(std::io::SeekFrom::Start(offset)).await?,
            Reader::Remote(file) => file.seek(std::io::SeekFrom::Start(offset)).await?,
        };
        Ok(())
    }
    async fn read(&mut self, buffer: &mut [u8]) -> AppResult<usize> {
        Ok(match self {
            Reader::Local(file) => file.read(buffer).await?,
            Reader::Remote(file) => file.read(buffer).await?,
        })
    }

    async fn finish(self) -> AppResult<()> {
        if let Reader::Remote(file) = self {
            tokio::time::timeout(std::time::Duration::from_secs(5), file.close())
                .await
                .map_err(|_| AppError::Ssh("sftp.transferTimedOut".into()))??;
        }
        Ok(())
    }
}

enum Writer {
    Local(tokio::fs::File),
    Remote(Box<russh_sftp::client::fs::File>),
}

impl Writer {
    async fn write_all(&mut self, buffer: &[u8]) -> AppResult<()> {
        match self {
            Writer::Local(file) => file.write_all(buffer).await?,
            Writer::Remote(file) => file.write_all(buffer).await?,
        }
        Ok(())
    }

    async fn finish(self) -> AppResult<()> {
        match self {
            Writer::Local(mut file) => file.flush().await?,
            Writer::Remote(file) => {
                tokio::time::timeout(std::time::Duration::from_secs(5), finish_remote_file(*file))
                    .await
                    .map_err(|_| AppError::Ssh("sftp.transferTimedOut".into()))??
            }
        }
        Ok(())
    }
}

async fn finish_remote_file(mut file: russh_sftp::client::fs::File) -> AppResult<()> {
    let flushed = file.flush().await;
    // Attempt CLOSE even after a write/flush error; Drop alone does not await it.
    let closed = file.close().await;
    flushed?;
    closed?;
    Ok(())
}

async fn is_dir(endpoint: &Endpoint, sftp: Option<&SftpSession>) -> AppResult<bool> {
    let (directory, symlink) = match sftp {
        Some(handle) => {
            let metadata = handle
                .symlink_metadata(&endpoint.path)
                .await
                .map_err(map_sftp)?;
            (metadata.is_dir(), metadata.is_symlink())
        }
        None => {
            let metadata = tokio::fs::symlink_metadata(&endpoint.path).await?;
            (metadata.is_dir(), local_metadata_is_link(&metadata))
        }
    };
    if symlink {
        return Err(AppError::validation("sftp.symlinkUnsupported"));
    }
    Ok(directory)
}

fn local_metadata_is_link(metadata: &std::fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // Junctions and other reparse points may redirect traversal as well.
        metadata.file_type().is_symlink() || metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    metadata.file_type().is_symlink()
}

fn reject_local_destination_link(path: &Path) -> AppResult<()> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) if local_metadata_is_link(&metadata) => {
            Err(AppError::validation("sftp.symlinkUnsupported"))
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

async fn reject_destination_link(endpoint: &Endpoint, sftp: Option<&SftpSession>) -> AppResult<()> {
    match sftp {
        Some(sftp) => reject_remote_destination_link(sftp, &endpoint.path).await,
        None => reject_local_destination_link(Path::new(&endpoint.path)),
    }
}

async fn reject_remote_destination_link(sftp: &SftpSession, path: &str) -> AppResult<()> {
    match sftp.symlink_metadata(path).await {
        Ok(metadata) if metadata.is_symlink() => {
            Err(AppError::validation("sftp.symlinkUnsupported"))
        }
        Ok(_) => Ok(()),
        Err(russh_sftp::client::error::Error::Status(status))
            if status.status_code == StatusCode::NoSuchFile =>
        {
            Ok(())
        }
        Err(error) => Err(map_sftp(error)),
    }
}

async fn children(endpoint: &Endpoint, sftp: Option<&SftpSession>) -> AppResult<Vec<String>> {
    match sftp {
        Some(handle) => Ok(handle
            .read_dir(&endpoint.path)
            .await
            .map_err(map_sftp)?
            .map(|entry| entry.path())
            .collect()),
        None => {
            let mut paths = Vec::new();
            let mut directory = tokio::fs::read_dir(&endpoint.path).await?;
            while let Some(entry) = directory.next_entry().await? {
                paths.push(display_path(&entry.path()));
            }
            Ok(paths)
        }
    }
}

async fn make_dir(endpoint: &Endpoint, sftp: Option<&SftpSession>) -> AppResult<()> {
    reject_destination_link(endpoint, sftp).await?;
    match sftp {
        Some(handle) => {
            if remote_exists(handle, &endpoint.path).await? {
                if !handle
                    .metadata(&endpoint.path)
                    .await
                    .map_err(map_sftp)?
                    .is_dir()
                {
                    return Err(AppError::validation("sftp.typeConflict"));
                }
                Ok(())
            } else {
                handle.create_dir(&endpoint.path).await.map_err(map_sftp)
            }
        }
        None => {
            tokio::fs::create_dir_all(&endpoint.path).await?;
            Ok(())
        }
    }
}

async fn measure(endpoint: &Endpoint, sftp: Option<&SftpSession>) -> AppResult<u64> {
    // One lstat supplies both the type and the length. A separate metadata
    // request for every file doubles the network round trips for large trees.
    let (directory, symlink, length) = match sftp {
        Some(handle) => {
            let metadata = handle
                .symlink_metadata(&endpoint.path)
                .await
                .map_err(map_sftp)?;
            (metadata.is_dir(), metadata.is_symlink(), metadata.len())
        }
        None => {
            let metadata = tokio::fs::symlink_metadata(&endpoint.path).await?;
            (
                metadata.is_dir(),
                local_metadata_is_link(&metadata),
                metadata.len(),
            )
        }
    };
    if symlink {
        return Err(AppError::validation("sftp.symlinkUnsupported"));
    }
    if directory {
        let mut total = 0;
        for path in children(endpoint, sftp).await? {
            total += Box::pin(measure(&endpoint.child(path), sftp)).await?;
        }
        return Ok(total);
    }
    Ok(length)
}

async fn open_reader(endpoint: &Endpoint, sftp: Option<&SftpSession>) -> AppResult<Reader> {
    Ok(match sftp {
        Some(handle) => Reader::Remote(Box::new(
            handle.open(&endpoint.path).await.map_err(map_sftp)?,
        )),
        None => Reader::Local(tokio::fs::File::open(&endpoint.path).await?),
    })
}

async fn open_writer(
    endpoint: &Endpoint,
    sftp: Option<&SftpSession>,
    overwrite: bool,
) -> AppResult<Writer> {
    reject_destination_link(endpoint, sftp).await?;
    Ok(match sftp {
        Some(handle) => Writer::Remote(Box::new(
            handle
                .open_with_flags(
                    &endpoint.path,
                    OpenFlags::WRITE
                        | OpenFlags::CREATE
                        | if overwrite {
                            OpenFlags::TRUNCATE
                        } else {
                            OpenFlags::EXCLUDE
                        },
                )
                .await
                .map_err(map_sftp)?,
        )),
        None => Writer::Local(
            tokio::fs::OpenOptions::new()
                .write(true)
                .create(overwrite)
                .create_new(!overwrite)
                .truncate(overwrite)
                .open(&endpoint.path)
                .await?,
        ),
    })
}

#[allow(clippy::too_many_arguments)]
async fn copy_entry(
    from: &Endpoint,
    to: &Endpoint,
    from_sftp: Option<&SftpSession>,
    to_sftp: Option<&SftpSession>,
    meter: &mut Meter<'_>,
    cancel: &Arc<AtomicBool>,
    overwrite: bool,
    durable_id: Option<&str>,
    resuming: bool,
) -> AppResult<()> {
    if cancel.load(Ordering::SeqCst) {
        return Err(AppError::Ssh(CANCELLED.into()));
    }

    if is_dir(from, from_sftp).await? {
        make_dir(to, to_sftp).await?;
        for path in children(from, from_sftp).await? {
            let child_from = from.child(path);
            let child_to = to.join(&file_name_of(&child_from.path));
            let child_to = to.child(child_to);
            Box::pin(copy_entry(
                &child_from,
                &child_to,
                from_sftp,
                to_sftp,
                meter,
                cancel,
                overwrite,
                durable_id,
                resuming,
            ))
            .await?;
        }
        return Ok(());
    }

    if let Some(id) = durable_id {
        return durable_copy_file(
            from, to, from_sftp, to_sftp, meter, cancel, overwrite, id, resuming,
        )
        .await;
    }
    if from_sftp.is_some() || to_sftp.is_some() {
        let size = source_stamp(from, from_sftp).await?.0;
        open_writer(to, to_sftp, overwrite).await?.finish().await?;
        let channels = range_io::Sessions::open(
            meter.app,
            from,
            to,
            &meter.settings,
            from_sftp,
            to_sftp,
            meter.total,
        )
        .await?;
        let files = range_io::Files::open(&channels, from, to)
            .await?
            .with_throttle(meter.throttle());
        let plan = segments::Plan::for_file(&meter.settings, size, true);
        let copied = async {
            let mut offset = 0;
            while offset < size {
                let end = offset
                    .saturating_add(plan.chunk * plan.workers as u64)
                    .min(size);
                segments::copy_window(&files, offset..end, plan, cancel, |bytes| meter.add(bytes))
                    .await?;
                offset = end;
            }
            Ok::<(), AppError>(())
        }
        .await;
        let closed = files.close().await;
        return copied.and(closed);
    }
    let mut reader = open_reader(from, from_sftp).await?;
    let result = async {
        let mut writer = open_writer(to, to_sftp, overwrite).await?;
        let copied = async {
            let mut buffer = vec![0_u8; CHUNK];
            loop {
                if cancel.load(Ordering::SeqCst) {
                    return Err(AppError::Ssh(CANCELLED.into()));
                }
                let read = reader.read(&mut buffer).await?;
                if read == 0 {
                    break;
                }
                writer.write_all(&buffer[..read]).await?;
                meter.add(read as u64);
            }
            Ok::<(), AppError>(())
        }
        .await;
        let closed = writer.finish().await;
        copied?;
        closed
    }
    .await;
    let closed = reader.finish().await;
    result?;
    closed?;
    Ok(())
}

async fn file_length(endpoint: &Endpoint, sftp: Option<&SftpSession>) -> AppResult<Option<u64>> {
    reject_destination_link(endpoint, sftp).await?;
    match sftp {
        Some(s) => match s.symlink_metadata(&endpoint.path).await {
            Ok(m) if m.is_dir() => Err(AppError::validation("sftp.typeConflict")),
            Ok(m) => Ok(Some(m.len())),
            Err(russh_sftp::client::error::Error::Status(st))
                if st.status_code == StatusCode::NoSuchFile =>
            {
                Ok(None)
            }
            Err(e) => Err(map_sftp(e)),
        },
        None => match tokio::fs::symlink_metadata(&endpoint.path).await {
            Ok(m) if m.is_dir() => Err(AppError::validation("sftp.typeConflict")),
            Ok(m) => Ok(Some(m.len())),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        },
    }
}
async fn rename_endpoint(
    from: &Endpoint,
    to: &Endpoint,
    sftp: Option<&SftpSession>,
) -> AppResult<()> {
    match sftp {
        Some(s) => s.rename(&from.path, &to.path).await.map_err(map_sftp),
        None => {
            tokio::fs::rename(&from.path, &to.path).await?;
            Ok(())
        }
    }
}
async fn verify_prefix(
    reader: &mut Reader,
    partial: &Endpoint,
    sftp: Option<&SftpSession>,
    length: u64,
    cancel: Option<&AtomicBool>,
) -> AppResult<()> {
    verify_range(reader, partial, sftp, 0, length, cancel).await
}

async fn verify_range(
    reader: &mut Reader,
    partial: &Endpoint,
    sftp: Option<&SftpSession>,
    offset: u64,
    length: u64,
    cancel: Option<&AtomicBool>,
) -> AppResult<()> {
    let mut other = open_reader(partial, sftp).await?;
    let mut left = length;
    let mut a = vec![0; CHUNK];
    let mut b = vec![0; CHUNK];
    let result = async {
        reader.seek(offset).await?;
        other.seek(offset).await?;
        while left > 0 {
            if cancel.is_some_and(|flag| flag.load(Ordering::SeqCst)) {
                return Err(AppError::Ssh(CANCELLED.into()));
            }
            let n = left.min(CHUNK as u64) as usize;
            let mut got = 0;
            while got < n {
                let read = interruptible(cancel, reader.read(&mut a[got..n])).await?;
                if read == 0 {
                    return Err(AppError::validation("sftp.resumePrefixMismatch"));
                }
                got += read;
            }
            let mut got = 0;
            while got < n {
                let read = interruptible(cancel, other.read(&mut b[got..n])).await?;
                if read == 0 {
                    return Err(AppError::validation("sftp.resumePrefixMismatch"));
                }
                got += read;
            }
            if a[..n] != b[..n] {
                return Err(AppError::validation("sftp.resumePrefixMismatch"));
            }
            left -= n as u64;
        }
        Ok(())
    }
    .await;
    let closed = other.finish().await;
    result?;
    closed
}
async fn source_stamp(
    endpoint: &Endpoint,
    sftp: Option<&SftpSession>,
) -> AppResult<(u64, Option<i64>)> {
    match sftp {
        Some(s) => {
            let m = s.symlink_metadata(&endpoint.path).await.map_err(map_sftp)?;
            if m.is_symlink() {
                return Err(AppError::validation("sftp.symlinkUnsupported"));
            }
            Ok((m.len(), m.modified().ok().and_then(millis)))
        }
        None => {
            let m = tokio::fs::symlink_metadata(&endpoint.path).await?;
            if local_metadata_is_link(&m) {
                return Err(AppError::validation("sftp.symlinkUnsupported"));
            }
            Ok((m.len(), m.modified().ok().and_then(millis)))
        }
    }
}
fn staging_endpoint(destination: &Endpoint, id: &str, suffix: &str) -> Endpoint {
    use sha2::{Digest, Sha256};
    let digest = format!("{:x}", Sha256::digest(destination.path.as_bytes()));
    let name = format!(".tunnelde-{id}-{}.{}", &digest[..16], suffix);
    let path = if destination.session.is_some() {
        let parent = destination
            .path
            .rsplit_once('/')
            .map(|(parent, _)| if parent.is_empty() { "/" } else { parent })
            .unwrap_or(".");
        join_remote(parent, &name)
    } else {
        let parent = Path::new(&destination.path)
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        display_path(&parent.join(name))
    };
    destination.child(path)
}

type BackupFingerprint = (u64, Option<i64>, String);
async fn fingerprint_file(
    endpoint: &Endpoint,
    sftp: Option<&SftpSession>,
    cancel: &AtomicBool,
) -> AppResult<BackupFingerprint> {
    use sha2::{Digest, Sha256};
    let before = source_stamp(endpoint, sftp).await?;
    let mut reader = open_reader(endpoint, sftp).await?;
    let result = async {
        let mut hash = Sha256::new();
        let mut buf = vec![0; CHUNK];
        loop {
            if cancel.load(Ordering::SeqCst) {
                return Err(AppError::Ssh(CANCELLED.into()));
            }
            let n = interruptible(Some(cancel), reader.read(&mut buf)).await?;
            if n == 0 {
                break;
            }
            hash.update(&buf[..n]);
        }
        Ok(format!("{:x}", hash.finalize()))
    }
    .await;
    let closed = reader.finish().await;
    let digest = result?;
    closed?;
    if source_stamp(endpoint, sftp).await? != before {
        return Err(AppError::validation("sftp.resumeSourceChanged"));
    }
    Ok((before.0, before.1, digest))
}
fn backup_checkpoint(app: &AppHandle, key: &str) -> AppResult<Option<BackupFingerprint>> {
    app.state::<AppState>().db.with(|conn| {
        use rusqlite::OptionalExtension;
        let raw: Option<String> = conn
            .query_row("SELECT value FROM settings WHERE key=?1", [key], |r| {
                r.get(0)
            })
            .optional()?;
        raw.map(|raw| serde_json::from_str(&raw).map_err(AppError::from))
            .transpose()
    })
}
async fn backup_is_owned(
    app: &AppHandle,
    key: &str,
    backup: &Endpoint,
    sftp: Option<&SftpSession>,
    cancel: &AtomicBool,
) -> AppResult<bool> {
    if file_length(backup, sftp).await?.is_none() {
        return Ok(false);
    }
    let expected =
        backup_checkpoint(app, key)?.ok_or_else(|| AppError::validation("sftp.alreadyExists"))?;
    if fingerprint_file(backup, sftp, cancel).await? != expected {
        return Err(AppError::validation("sftp.resumePrefixMismatch"));
    }
    Ok(true)
}
async fn remove_verified_backup(
    backup: &Endpoint,
    sftp: Option<&SftpSession>,
    expected: &BackupFingerprint,
    cancel: &AtomicBool,
) -> AppResult<()> {
    if fingerprint_file(backup, sftp, cancel).await? != *expected {
        return Err(AppError::validation("sftp.resumePrefixMismatch"));
    }
    remove_endpoint(backup, sftp).await
}
async fn cleanup_backup(
    app: &AppHandle,
    key: &str,
    backup: &Endpoint,
    sftp: Option<&SftpSession>,
    cancel: &AtomicBool,
) -> AppResult<()> {
    let Some(expected) = backup_checkpoint(app, key)? else {
        return Ok(());
    };
    if file_length(backup, sftp).await?.is_some() {
        remove_verified_backup(backup, sftp, &expected, cancel).await?;
    }
    app.state::<AppState>().db.with(|conn| {
        conn.execute("DELETE FROM settings WHERE key=?1", [key])?;
        Ok(())
    })
}

#[allow(clippy::too_many_arguments)]
async fn durable_copy_file(
    from: &Endpoint,
    to: &Endpoint,
    from_sftp: Option<&SftpSession>,
    to_sftp: Option<&SftpSession>,
    meter: &mut Meter<'_>,
    cancel: &Arc<AtomicBool>,
    overwrite: bool,
    id: &str,
    resuming: bool,
) -> AppResult<()> {
    use sha2::{Digest, Sha256};
    let stamp = source_stamp(from, from_sftp).await?;
    let key = format!(
        "transfer-file:{id}:{:x}",
        Sha256::digest(to.path.as_bytes())
    );
    let backup = staging_endpoint(to, id, "backup");
    let backup_key = key.replacen("transfer-file:", "transfer-backup:", 1);
    let saved = meter.app.state::<AppState>().db.with(|conn| {
        use rusqlite::OptionalExtension;
        Ok(conn
            .query_row("SELECT value FROM settings WHERE key=?1", [&key], |r| {
                r.get::<_, String>(0)
            })
            .optional()?)
    })?;
    if let Some(saved) = saved {
        let old: (u64, Option<i64>, bool) = serde_json::from_str(&saved)?;
        if old.0 != stamp.0 || old.1 != stamp.1 {
            return Err(AppError::validation("sftp.resumeSourceChanged"));
        }
        if old.2 {
            phase(meter.app, id, "verifying");
            let mut source = open_reader(from, from_sftp).await?;
            if file_length(to, to_sftp).await? != Some(stamp.0) {
                return Err(AppError::validation("sftp.resumePrefixMismatch"));
            }
            verify_prefix(&mut source, to, to_sftp, stamp.0, Some(cancel)).await?;
            source.finish().await?;
            cleanup_backup(meter.app, &backup_key, &backup, to_sftp, cancel).await?;
            meter.add(stamp.0);
            return Ok(());
        }
    }
    let journal_app = meter.app;
    let save = |completed: bool| -> AppResult<()> {
        journal_app.state::<AppState>().db.with(|conn|{conn.execute("INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",rusqlite::params![&key,serde_json::to_string(&(stamp.0,stamp.1,completed))?,crate::models::now_ms()])?;Ok(())})
    };
    save(false)?;
    let temp = staging_endpoint(to, id, "part");
    if resuming {
        artifacts::recover_window(meter.app, &key, stamp, &temp, to_sftp).await?;
    }
    let partial = if resuming {
        file_length(&temp, to_sftp).await?
    } else {
        None
    };
    if resuming && partial.is_none() && file_length(to, to_sftp).await? == Some(stamp.0) {
        phase(meter.app, id, "verifying");
        let mut completed = open_reader(from, from_sftp).await?;
        let checked = verify_prefix(&mut completed, to, to_sftp, stamp.0, Some(cancel)).await;
        completed.finish().await?;
        if checked.is_ok() {
            cleanup_backup(meter.app, &backup_key, &backup, to_sftp, cancel).await?;
            save(true)?;
            meter.add(stamp.0);
            return Ok(());
        }
    }
    let existing = partial.unwrap_or(0);
    if existing > stamp.0 {
        return Err(AppError::validation("sftp.resumePrefixMismatch"));
    }
    let mut reader = open_reader(from, from_sftp).await?;
    if existing > 0 {
        phase(meter.app, id, "verifying");
        let verified = artifacts::resume_offset(
            meter.app,
            &key,
            stamp,
            &temp,
            to_sftp,
            &mut reader,
            existing,
            cancel,
        )
        .await;
        if let Err(error) = verified {
            let _ = reader.finish().await;
            return Err(error);
        }
    }
    let destination_exists = file_length(to, to_sftp).await?.is_some();
    if destination_exists && !overwrite {
        return Err(AppError::validation("sftp.alreadyExists"));
    }
    if partial.is_none() && file_length(&temp, to_sftp).await?.is_some() {
        return Err(AppError::validation("sftp.alreadyExists"));
    }
    artifacts::record(meter.app, id, to)?;
    let mut writer = if partial.is_some() {
        match to_sftp {
            Some(s) => Writer::Remote(Box::new(
                s.open_with_flags(&temp.path, OpenFlags::WRITE)
                    .await
                    .map_err(map_sftp)?,
            )),
            None => Writer::Local(
                tokio::fs::OpenOptions::new()
                    .write(true)
                    .open(&temp.path)
                    .await?,
            ),
        }
    } else {
        open_writer(&temp, to_sftp, false).await?
    };
    if existing > 0 {
        match &mut writer {
            Writer::Local(f) => {
                f.seek(std::io::SeekFrom::Start(existing)).await?;
            }
            Writer::Remote(f) => {
                f.seek(std::io::SeekFrom::Start(existing)).await?;
            }
        }
    }
    meter.add(existing);
    progress(meter.app, id, meter.name, meter.transferred, meter.total);
    let plan = segments::Plan::for_file(
        &meter.settings,
        stamp.0.saturating_sub(existing),
        from_sftp.is_some() || to_sftp.is_some(),
    );
    let copied = if from_sftp.is_some() || to_sftp.is_some() {
        let (closed, read_closed) = tokio::join!(writer.finish(), reader.finish());
        closed?;
        read_closed?;
        parallel_copy_file(
            from, &temp, from_sftp, to_sftp, meter, cancel, &key, stamp, existing, plan,
        )
        .await
    } else {
        let mut confirmed = existing;
        let mut attempted = existing;
        let result = async {
            let mut buf = vec![0; CHUNK];
            loop {
                if cancel.load(Ordering::SeqCst) {
                    return Err(AppError::Ssh(CANCELLED.into()));
                }
                let n = interruptible(Some(cancel), reader.read(&mut buf)).await?;
                if n == 0 {
                    break;
                }
                attempted = confirmed + n as u64;
                interruptible(Some(cancel), writer.write_all(&buf[..n])).await?;
                confirmed += n as u64;
                meter.add(n as u64);
            }
            Ok(())
        }
        .await;
        let closed = writer.finish().await;
        let read_closed = reader.finish().await;
        if closed.is_ok() && (result.is_ok() || cancel.load(Ordering::SeqCst)) {
            // Closing flushes an interrupted sequential write too. Its resulting
            // length must lie within the source bytes submitted to this writer.
            if let Err(error) = artifacts::checkpoint(
                meter.app,
                &key,
                stamp,
                &temp,
                to_sftp,
                confirmed..=attempted,
            )
            .await
            {
                tracing::warn!(%error, "Cannot save transfer resume checkpoint");
            }
        }
        result.and(closed).and(read_closed)
    };
    copied?;
    if source_stamp(from, from_sftp).await? != stamp {
        return Err(AppError::validation("sftp.resumeSourceChanged"));
    }
    if cancel.load(Ordering::SeqCst) {
        return Err(AppError::Ssh(CANCELLED.into()));
    }
    // Persist the old target fingerprint before moving it, so both rename
    // crash windows can recover without treating an unrelated file as ours.
    let mut own_backup = backup_is_owned(meter.app, &backup_key, &backup, to_sftp, cancel).await?;
    if destination_exists {
        if own_backup {
            return Err(AppError::validation("sftp.alreadyExists"));
        }
        let expected = fingerprint_file(to, to_sftp, cancel).await?;
        meter.app.state::<AppState>().db.with(|conn|{conn.execute("INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",rusqlite::params![&backup_key,serde_json::to_string(&expected)?,crate::models::now_ms()])?;Ok(())})?;
        rename_endpoint(to, &backup, to_sftp).await?;
        own_backup = true;
    }
    if let Err(e) = rename_endpoint(&temp, to, to_sftp).await {
        if own_backup
            && file_length(to, to_sftp).await?.is_none()
            && backup_is_owned(meter.app, &backup_key, &backup, to_sftp, cancel).await?
        {
            let _ = rename_endpoint(&backup, to, to_sftp).await;
        }
        return Err(e);
    }
    cleanup_backup(meter.app, &backup_key, &backup, to_sftp, cancel).await?;
    save(true)?;
    Ok(())
}

async fn validate_move_source(
    app: &AppHandle,
    id: &str,
    from: &Endpoint,
    to: &Endpoint,
    sftp: Option<&SftpSession>,
) -> AppResult<()> {
    use sha2::{Digest, Sha256};
    if is_dir(from, sftp).await? {
        for path in children(from, sftp).await? {
            let source = from.child(path);
            let destination = to.child(to.join(&file_name_of(&source.path)));
            Box::pin(validate_move_source(app, id, &source, &destination, sftp)).await?;
        }
        return Ok(());
    }
    let key = format!(
        "transfer-file:{id}:{:x}",
        Sha256::digest(to.path.as_bytes())
    );
    let stamp = source_stamp(from, sftp).await?;
    let raw = app
        .state::<AppState>()
        .db
        .with(|conn| {
            use rusqlite::OptionalExtension;
            Ok(conn
                .query_row("SELECT value FROM settings WHERE key=?1", [key], |r| {
                    r.get::<_, String>(0)
                })
                .optional()?)
        })?
        .ok_or_else(|| AppError::validation("sftp.resumeSourceChanged"))?;
    let saved: (u64, Option<i64>, bool) = serde_json::from_str(&raw)?;
    if (saved.0, saved.1) != stamp || !saved.2 {
        return Err(AppError::validation("sftp.resumeSourceChanged"));
    }
    Ok(())
}

async fn remove_endpoint(endpoint: &Endpoint, sftp: Option<&SftpSession>) -> AppResult<()> {
    match sftp {
        Some(handle) => remove_remote_entry(handle, &endpoint.path).await,
        None => remove_local_entry(&PathBuf::from(&endpoint.path)),
    }
}

#[allow(clippy::too_many_arguments)]
async fn parallel_copy_file(
    from: &Endpoint,
    temp: &Endpoint,
    from_sftp: Option<&SftpSession>,
    to_sftp: Option<&SftpSession>,
    meter: &mut Meter<'_>,
    cancel: &AtomicBool,
    key: &str,
    stamp: (u64, Option<i64>),
    mut offset: u64,
    plan: segments::Plan,
) -> AppResult<()> {
    let previous_files = meter.transferred.saturating_sub(offset);
    if meter.data_channels.is_none() {
        meter.data_channels = Some(
            interruptible(
                Some(cancel),
                range_io::Sessions::open(
                    meter.app,
                    from,
                    temp,
                    &meter.settings,
                    from_sftp,
                    to_sftp,
                    meter.total,
                ),
            )
            .await?,
        );
    }
    let channels = meter.data_channels.as_ref().unwrap().clone();
    let files = range_io::Files::open(&channels, from, temp)
        .await?
        .with_throttle(meter.throttle());
    let result = async {
        while offset < stamp.0 {
            if cancel.load(Ordering::SeqCst) {
                return Err(AppError::Ssh(CANCELLED.into()));
            }
            let end = offset
                .saturating_add(plan.chunk * plan.workers as u64)
                .min(stamp.0);
            artifacts::begin_window(meter.app, key, stamp, offset)?;
            segments::copy_window(&files, offset..end, plan, cancel, |bytes| meter.add(bytes))
                .await?;
            artifacts::checkpoint(meter.app, key, stamp, temp, to_sftp, end..=end).await?;
            artifacts::end_window(meter.app, key)?;
            offset = end;
        }
        Ok::<(), AppError>(())
    }
    .await;
    let closed = files.close().await;
    if result.is_err() && closed.is_ok() {
        let recovered = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            segments::resize(temp, to_sftp, offset),
        )
        .await;
        if matches!(recovered, Ok(Ok(()))) {
            artifacts::checkpoint(meter.app, key, stamp, temp, to_sftp, offset..=offset).await?;
            artifacts::end_window(meter.app, key)?;
        }
    }
    if result.is_err() || closed.is_err() {
        meter.data_channels = None;
    }
    if result.is_err() {
        meter.retain(previous_files + offset)?;
    }
    result.and(closed)
}

struct TransferOptions {
    remove_source: bool,
    overwrite: bool,
    durable: bool,
    resuming: bool,
}

async fn run(
    app: &AppHandle,
    from: &Endpoint,
    to: &Endpoint,
    id: &str,
    name: &str,
    cancel: &Arc<AtomicBool>,
    options: TransferOptions,
) -> Outcome {
    let scheduler = app.state::<AppState>().transfers.scheduler.clone();
    let waiting = async {
        Ok(scheduler
            .acquire(from.session.as_deref(), to.session.as_deref())
            .await)
    };
    tokio::pin!(waiting);
    let permit = match futures_util::poll!(&mut waiting) {
        std::task::Poll::Ready(result) => result,
        std::task::Poll::Pending => {
            phase(app, id, "queued");
            interruptible(Some(cancel), waiting).await
        }
    };
    let _permit = match permit {
        Ok(permit) => permit,
        Err(error) => return Outcome::from_result(Err(error), 0, cancel),
    };
    phase(app, id, "preparing");
    let TransferOptions {
        remove_source,
        overwrite,
        durable,
        resuming,
    } = options;
    // SFTP v3 rename cannot replace existing targets. Confirmed overwrites use
    // the copy/merge path below and only remove the source after completion.
    if remove_source && !overwrite && !resuming && !durable {
        if let (Some(from_session), Some(to_session)) = (&from.session, &to.session) {
            if from_session == to_session {
                let sftp = match session(app, from_session).await {
                    Ok(value) => value,
                    Err(error) => return Outcome::Failed(0, error.to_string()),
                };
                let total = measure(from, Some(&sftp)).await.unwrap_or(0);
                progress(app, id, name, 0, total);
                let result = async {
                    if cancel.load(Ordering::SeqCst) {
                        return Err(AppError::Ssh(CANCELLED.into()));
                    }
                    check_remote_destination(&sftp, &from.path, &to.path, overwrite).await?;
                    sftp.rename(&from.path, &to.path).await.map_err(map_sftp)?;
                    Ok::<(), AppError>(())
                }
                .await;
                let _ = sftp.close().await;
                let transferred = if result.is_ok() { total } else { 0 };
                return Outcome::from_result(result, transferred, cancel);
            }
        }
    }

    let settings = app.state::<AppState>().settings();
    let config = segments::config(&settings);
    let from_sftp = match &from.session {
        Some(session_id) => match interruptible(
            Some(cancel),
            session_with_config(app, session_id, config.clone()),
        )
        .await
        {
            Ok(value) => Some(value),
            Err(error) => return Outcome::from_result(Err(error), 0, cancel),
        },
        None => None,
    };
    let to_sftp = match &to.session {
        Some(session_id) => {
            match interruptible(Some(cancel), session_with_config(app, session_id, config)).await {
                Ok(value) => Some(value),
                Err(error) => {
                    if let Some(sftp) = from_sftp {
                        let _ =
                            tokio::time::timeout(std::time::Duration::from_secs(5), sftp.close())
                                .await;
                    }
                    return Outcome::from_result(Err(error), 0, cancel);
                }
            }
        }
        None => None,
    };

    if durable && resuming && remove_source {
        if let Ok(row) = durable::Journal::get(app, id) {
            if row.deleting_source {
                let source_exists = match from_sftp.as_ref() {
                    Some(s) => remote_exists(s, &from.path).await,
                    None => Path::new(&from.path).try_exists().map_err(AppError::from),
                };
                if matches!(source_exists, Ok(false)) {
                    let target_exists = match to_sftp.as_ref() {
                        Some(s) => remote_exists(s, &to.path).await,
                        None => Path::new(&to.path).try_exists().map_err(AppError::from),
                    };
                    if let Some(s) = from_sftp {
                        let _ = s.close().await;
                    }
                    if let Some(s) = to_sftp {
                        let _ = s.close().await;
                    }
                    return if matches!(target_exists, Ok(true)) {
                        Outcome::Done(row.total)
                    } else {
                        Outcome::Failed(row.transferred, "sftp.resumePrefixMismatch".into())
                    };
                }
            }
        }
    }
    let measured = interruptible(Some(cancel), measure(from, from_sftp.as_ref())).await;
    if cancel.load(Ordering::SeqCst) {
        if let Some(sftp) = from_sftp {
            let _ = tokio::time::timeout(std::time::Duration::from_secs(5), sftp.close()).await;
        }
        if let Some(sftp) = to_sftp {
            let _ = tokio::time::timeout(std::time::Duration::from_secs(5), sftp.close()).await;
        }
        return Outcome::Cancelled(0);
    }
    let total = measured.unwrap_or(0);
    progress(app, id, name, 0, total);

    let mut meter = Meter::new(app, id, name, total);
    if let Ok(mut row) = durable::Journal::get(app, id) {
        row.total = total;
        let _ = durable::Journal::upsert(app, row);
    }
    let result = async {
        if !resuming && from.session == to.session {
            match from_sftp.as_ref() {
                Some(sftp) => {
                    check_remote_destination(sftp, &from.path, &to.path, overwrite).await?
                }
                None => {
                    check_local_destination(Path::new(&from.path), Path::new(&to.path), overwrite)?
                }
            }
        } else if !resuming && !overwrite {
            let exists = match to_sftp.as_ref() {
                Some(sftp) => remote_exists(sftp, &to.path).await?,
                None => Path::new(&to.path).try_exists()?,
            };
            if exists {
                return Err(AppError::validation("sftp.alreadyExists"));
            }
        }
        copy_entry(
            from,
            to,
            from_sftp.as_ref(),
            to_sftp.as_ref(),
            &mut meter,
            cancel,
            overwrite,
            if durable { Some(id) } else { None },
            resuming,
        )
        .await?;
        if cancel.load(Ordering::SeqCst) {
            return Err(AppError::Ssh(CANCELLED.into()));
        }
        if remove_source {
            if durable {
                validate_move_source(app, id, from, to, from_sftp.as_ref()).await?;
                let mut row = durable::Journal::get(app, id)?;
                row.deleting_source = true;
                row.total = meter.total;
                durable::Journal::upsert(app, row)?;
            }
            remove_endpoint(from, from_sftp.as_ref()).await?;
        }
        Ok::<(), AppError>(())
    }
    .await;

    if let Some(sftp) = from_sftp {
        let _ = tokio::time::timeout(std::time::Duration::from_secs(5), sftp.close()).await;
    }
    if let Some(sftp) = to_sftp {
        let _ = tokio::time::timeout(std::time::Duration::from_secs(5), sftp.close()).await;
    }

    Outcome::from_result(result, meter.transferred, cancel)
}

const MAX_TEXT: u64 = 2 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextFile {
    pub content: String,
    pub size: u64,
}

fn decode_text(bytes: Vec<u8>) -> AppResult<TextFile> {
    let size = bytes.len() as u64;
    if size > MAX_TEXT {
        return Err(AppError::Ssh("sftp.fileTooLarge".into()));
    }
    let content =
        String::from_utf8(bytes).map_err(|_| AppError::Ssh("sftp.unsupportedEncoding".into()))?;
    if content.contains('\0') {
        return Err(AppError::Ssh("sftp.binaryFile".into()));
    }
    Ok(TextFile { content, size })
}

/// Read a local editor document with the same bounds and encoding checks as SFTP.
pub async fn local_read_text(path: &str) -> AppResult<TextFile> {
    let path = Path::new(path);
    if !path.is_absolute() {
        return Err(AppError::validation("sftp.absolutePathRequired"));
    }
    // Check before opening to avoid blocking on device files or named pipes.
    if !tokio::fs::metadata(path).await?.is_file() {
        return Err(AppError::validation("sftp.notRegularFile"));
    }
    let mut file = tokio::fs::File::open(path).await?;
    let metadata = file.metadata().await?;
    if !metadata.is_file() {
        return Err(AppError::validation("sftp.notRegularFile"));
    }
    if metadata.len() > MAX_TEXT {
        return Err(AppError::Ssh("sftp.fileTooLarge".into()));
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(MAX_TEXT + 1)
        .read_to_end(&mut bytes)
        .await?;
    decode_text(bytes)
}

/// Check the last loaded content before overwriting an existing local file.
pub async fn local_write_text(path: &str, content: &str, baseline: &str) -> AppResult<()> {
    let path = Path::new(path);
    if !path.is_absolute() {
        return Err(AppError::validation("sftp.absolutePathRequired"));
    }
    if content.len() as u64 > MAX_TEXT || baseline.len() as u64 > MAX_TEXT {
        return Err(AppError::Ssh("sftp.fileTooLarge".into()));
    }
    if content.contains('\0') {
        return Err(AppError::Ssh("sftp.binaryFile".into()));
    }
    // Check before opening to avoid blocking on device files or named pipes.
    if !tokio::fs::metadata(path).await?.is_file() {
        return Err(AppError::validation("sftp.notRegularFile"));
    }
    // Opening without create preserves deletion, and avoids truncation before validation.
    let mut file = tokio::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .await?;
    let metadata = file.metadata().await?;
    if !metadata.is_file() {
        return Err(AppError::validation("sftp.notRegularFile"));
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(MAX_TEXT + 1)
        .read_to_end(&mut bytes)
        .await?;
    if decode_text(bytes)?.content != baseline {
        return Err(AppError::validation("editor.localFileChanged"));
    }
    file.seek(std::io::SeekFrom::Start(0)).await?;
    file.write_all(content.as_bytes()).await?;
    file.set_len(content.len() as u64).await?;
    file.flush().await?;
    Ok(())
}

pub async fn read_text(app: &AppHandle, session_id: &str, path: &str) -> AppResult<TextFile> {
    let sftp = session(app, session_id).await?;
    let result = read_remote_text(&sftp, path).await;
    let _ = sftp.close().await;
    result
}

async fn read_remote_text(sftp: &SftpSession, path: &str) -> AppResult<TextFile> {
    let metadata = sftp.metadata(path).await.map_err(map_sftp)?;
    if metadata.len() > MAX_TEXT {
        return Err(AppError::Ssh("sftp.fileTooLarge".into()));
    }
    // Bound the read as well: the file may grow after the metadata request.
    let mut reader = sftp.open(path).await.map_err(map_sftp)?;
    let mut bytes = Vec::new();
    let read = (&mut reader)
        .take(MAX_TEXT + 1)
        .read_to_end(&mut bytes)
        .await;
    let closed = reader.close().await;
    read?;
    closed?;
    decode_text(bytes)
}

pub async fn write_text(
    app: &AppHandle,
    session_id: &str,
    path: &str,
    content: &str,
) -> AppResult<()> {
    if content.len() as u64 > MAX_TEXT {
        return Err(AppError::Ssh("sftp.fileTooLarge".into()));
    }
    let sftp = session(app, session_id).await?;
    let result = write_remote_text(&sftp, path, content).await;
    let _ = sftp.close().await;
    result
}

async fn write_remote_text(sftp: &SftpSession, path: &str, content: &str) -> AppResult<()> {
    // Saving edits replaces an existing file; it must not recreate a deleted one.
    let mut writer = sftp
        .open_with_flags(path, OpenFlags::WRITE | OpenFlags::TRUNCATE)
        .await
        .map_err(map_sftp)?;
    let written = writer.write_all(content.as_bytes()).await;
    let closed = finish_remote_file(writer).await;
    written?;
    closed
}

pub async fn remote_copy(
    app: &AppHandle,
    session_id: &str,
    from: String,
    to: String,
    overwrite: bool,
) -> AppResult<()> {
    let sftp = session(app, session_id).await?;
    let result = async {
        check_remote_destination(&sftp, &from, &to, overwrite).await?;
        copy_remote_entry(&sftp, &from, &to, overwrite).await
    }
    .await;
    let _ = sftp.close().await;
    result
}

pub fn local_copy(from: String, to: String, overwrite: bool) -> AppResult<()> {
    let from = PathBuf::from(from);
    let to = PathBuf::from(to);
    check_local_destination(&from, &to, overwrite)?;
    copy_local_entry(&from, &to, overwrite)
}

fn check_local_destination(from: &Path, to: &Path, overwrite: bool) -> AppResult<()> {
    let source = std::fs::canonicalize(from)?;
    let destination = if to.exists() {
        std::fs::canonicalize(to)?
    } else {
        let parent = to
            .parent()
            .ok_or_else(|| AppError::validation("sftp.invalidName"))?;
        std::fs::canonicalize(parent)?.join(
            to.file_name()
                .ok_or_else(|| AppError::validation("sftp.invalidName"))?,
        )
    };
    if destination == source || (source.is_dir() && destination.starts_with(&source)) {
        return Err(AppError::validation("sftp.samePath"));
    }
    if to.try_exists()? {
        if !overwrite {
            return Err(AppError::validation("sftp.alreadyExists"));
        }
        if from.is_dir() != to.is_dir() {
            return Err(AppError::validation("sftp.typeConflict"));
        }
    }
    Ok(())
}

async fn remote_exists(sftp: &SftpSession, path: &str) -> AppResult<bool> {
    match sftp.symlink_metadata(path).await {
        Ok(_) => Ok(true),
        Err(russh_sftp::client::error::Error::Status(status))
            if status.status_code == StatusCode::NoSuchFile =>
        {
            Ok(false)
        }
        Err(error) => Err(map_sftp(error)),
    }
}

async fn check_remote_destination(
    sftp: &SftpSession,
    from: &str,
    to: &str,
    overwrite: bool,
) -> AppResult<()> {
    let source = sftp.canonicalize(from).await.map_err(map_sftp)?;
    let parent = to
        .rsplit_once('/')
        .map(|(parent, _)| if parent.is_empty() { "/" } else { parent })
        .unwrap_or(".");
    let name = to.rsplit('/').next().unwrap_or(to);
    let destination = if remote_exists(sftp, to).await? {
        sftp.canonicalize(to).await.map_err(map_sftp)?
    } else {
        join_remote(&sftp.canonicalize(parent).await.map_err(map_sftp)?, name)
    };
    if destination == source
        || destination.starts_with(&format!("{}/", source.trim_end_matches('/')))
    {
        return Err(AppError::validation("sftp.samePath"));
    }
    if remote_exists(sftp, to).await? {
        if !overwrite {
            return Err(AppError::validation("sftp.alreadyExists"));
        }
        if sftp.metadata(from).await.map_err(map_sftp)?.is_dir()
            != sftp.metadata(to).await.map_err(map_sftp)?.is_dir()
        {
            return Err(AppError::validation("sftp.typeConflict"));
        }
    }
    Ok(())
}

fn join_remote(directory: &str, name: &str) -> String {
    if directory.ends_with('/') {
        format!("{directory}{name}")
    } else {
        format!("{directory}/{name}")
    }
}

fn remove_local_entry(path: &Path) -> AppResult<()> {
    if path.is_dir() {
        std::fs::remove_dir_all(path)?;
    } else {
        std::fs::remove_file(path)?;
    }
    Ok(())
}

fn copy_local_entry(from: &Path, to: &Path, overwrite: bool) -> AppResult<()> {
    let metadata = std::fs::symlink_metadata(from)?;
    if local_metadata_is_link(&metadata) {
        return Err(AppError::validation("sftp.symlinkUnsupported"));
    }
    reject_local_destination_link(to)?;
    if metadata.is_dir() {
        std::fs::create_dir_all(to)?;
        for entry in std::fs::read_dir(from)? {
            let entry = entry?;
            copy_local_entry(&entry.path(), &to.join(entry.file_name()), overwrite)?;
        }
        return Ok(());
    }
    let mut reader = std::fs::File::open(from)?;
    let mut writer = std::fs::OpenOptions::new()
        .write(true)
        .create(overwrite)
        .create_new(!overwrite)
        .truncate(overwrite)
        .open(to)?;
    std::io::copy(&mut reader, &mut writer)?;
    Ok(())
}

async fn copy_remote_entry(
    sftp: &SftpSession,
    from: &str,
    to: &str,
    overwrite: bool,
) -> AppResult<()> {
    let metadata = sftp.symlink_metadata(from).await.map_err(map_sftp)?;
    if metadata.is_symlink() {
        return Err(AppError::validation("sftp.symlinkUnsupported"));
    }
    reject_remote_destination_link(sftp, to).await?;
    if metadata.is_dir() {
        if remote_exists(sftp, to).await? {
            if !overwrite {
                return Err(AppError::validation("sftp.alreadyExists"));
            }
            if !sftp.metadata(to).await.map_err(map_sftp)?.is_dir() {
                return Err(AppError::validation("sftp.typeConflict"));
            }
        } else {
            sftp.create_dir(to).await.map_err(map_sftp)?;
        }
        let children: Vec<String> = sftp
            .read_dir(from)
            .await
            .map_err(map_sftp)?
            .map(|entry| entry.file_name())
            .collect();
        for name in children {
            let child_from = join_remote(from, &name);
            let child_to = join_remote(to, &name);
            Box::pin(copy_remote_entry(sftp, &child_from, &child_to, overwrite)).await?;
        }
        return Ok(());
    }

    let mut reader = sftp.open(from).await.map_err(map_sftp)?;
    let result = async {
        let mut writer = sftp
            .open_with_flags(
                to,
                OpenFlags::WRITE
                    | OpenFlags::CREATE
                    | if overwrite {
                        OpenFlags::TRUNCATE
                    } else {
                        OpenFlags::EXCLUDE
                    },
            )
            .await
            .map_err(map_sftp)?;
        let copied = tokio::io::copy(&mut reader, &mut writer).await;
        let closed = finish_remote_file(writer).await;
        copied?;
        closed
    }
    .await;
    let closed = reader.close().await;
    result?;
    closed?;
    Ok(())
}

async fn remove_remote_entry(sftp: &SftpSession, path: &str) -> AppResult<()> {
    // Never follow a directory symlink while deleting: only unlink the link.
    let metadata = sftp.symlink_metadata(path).await.map_err(map_sftp)?;
    if metadata.is_dir() {
        let children: Vec<String> = sftp
            .read_dir(path)
            .await
            .map_err(map_sftp)?
            .map(|entry| entry.path())
            .collect();
        for child in children {
            Box::pin(remove_remote_entry(sftp, &child)).await?;
        }
        sftp.remove_dir(path).await.map_err(map_sftp)?;
    } else {
        sftp.remove_file(path).await.map_err(map_sftp)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn resume_prefix_verifies_every_byte_and_keeps_reader_at_resume_offset() {
        let root =
            std::env::temp_dir().join(format!("tunnelde-resume-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let source = root.join("source");
        let partial = root.join("partial");
        let content: Vec<u8> = (0..(CHUNK * 3 + 19)).map(|n| (n % 251) as u8).collect();
        std::fs::write(&source, &content).unwrap();
        std::fs::write(&partial, &content[..CHUNK + 17]).unwrap();
        let src = Endpoint {
            session: None,
            path: source.to_string_lossy().into_owned(),
        };
        let part = Endpoint {
            session: None,
            path: partial.to_string_lossy().into_owned(),
        };
        let mut reader = open_reader(&src, None).await.unwrap();
        verify_prefix(&mut reader, &part, None, (CHUNK + 17) as u64, None)
            .await
            .unwrap();
        let mut remainder = vec![0; content.len()];
        let n = reader.read(&mut remainder).await.unwrap();
        assert_eq!(&remainder[..n], &content[CHUNK + 17..CHUNK + 17 + n]);
        reader.finish().await.unwrap();
        let mut corrupt = content[..CHUNK + 17].to_vec();
        corrupt[CHUNK + 10] ^= 1;
        std::fs::write(&partial, corrupt).unwrap();
        let mut reader = open_reader(&src, None).await.unwrap();
        assert!(
            verify_prefix(&mut reader, &part, None, (CHUNK + 17) as u64, None)
                .await
                .is_err()
        );
        reader.finish().await.unwrap();
        std::fs::write(&partial, &content[..19]).unwrap();
        let mut reader = open_reader(&src, None).await.unwrap();
        assert!(verify_prefix(&mut reader, &part, None, 100, None)
            .await
            .is_err());
        reader.finish().await.unwrap();
        let cancelled = AtomicBool::new(true);
        let mut reader = open_reader(&src, None).await.unwrap();
        assert_eq!(
            verify_prefix(&mut reader, &part, None, 19, Some(&cancelled))
                .await
                .unwrap_err()
                .to_string(),
            CANCELLED
        );
        reader.finish().await.unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }
    #[tokio::test]
    async fn owned_backup_recovery_cleans_only_fingerprint_matched_files_after_commit() {
        let root =
            std::env::temp_dir().join(format!("tunnelde-backup-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let target = Endpoint {
            session: None,
            path: root.join("target").to_string_lossy().into_owned(),
        };
        let backup = target.child(format!("{}.backup", target.path));
        let temp = target.child(format!("{}.part", target.path));
        let cancel = AtomicBool::new(false);
        std::fs::write(&target.path, b"old target").unwrap();
        std::fs::write(&temp.path, b"new complete file").unwrap();
        let recorded = fingerprint_file(&target, None, &cancel).await.unwrap();
        rename_endpoint(&target, &backup, None).await.unwrap();
        // App restarts in the first rename window: old target remains intact.
        assert_eq!(
            fingerprint_file(&backup, None, &cancel).await.unwrap(),
            recorded
        );
        assert!(!std::path::Path::new(&target.path).exists());
        rename_endpoint(&temp, &target, None).await.unwrap();
        // App restarts in the second rename window: the verified committed
        // target and journal fingerprint allow removing only our old backup.
        remove_verified_backup(&backup, None, &recorded, &cancel)
            .await
            .unwrap();
        assert_eq!(std::fs::read(&target.path).unwrap(), b"new complete file");
        std::fs::write(&backup.path, b"another user's unrelated file").unwrap();
        assert!(remove_verified_backup(&backup, None, &recorded, &cancel)
            .await
            .is_err());
        assert_eq!(
            std::fs::read(&backup.path).unwrap(),
            b"another user's unrelated file"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn staging_names_remain_short_siblings_for_long_names_and_nested_paths() {
        let id = "00000000-0000-0000-0000-000000000000";
        let name = "x".repeat(240);
        for directory in ["/", "/home/user/nested/"] {
            let destination = Endpoint {
                session: Some("session".into()),
                path: format!("{directory}{name}"),
            };
            let stage = staging_endpoint(&destination, id, "part");
            let backup = staging_endpoint(&destination, id, "backup");
            assert_eq!(stage.session, destination.session);
            assert_eq!(
                stage.path.rsplit_once('/').unwrap().0,
                destination.path.rsplit_once('/').unwrap().0
            );
            assert!(file_name_of(&stage.path).len() < 100);
            assert!(file_name_of(&backup.path).len() < 100);
            assert_ne!(stage.path, backup.path);
            assert_eq!(stage.path, staging_endpoint(&destination, id, "part").path);
            assert_ne!(
                stage.path,
                staging_endpoint(&destination.child(format!("{directory}other")), id, "part").path
            );
        }
        let parent = std::env::temp_dir().join("nested");
        let destination = Endpoint {
            session: None,
            path: parent.join(name).to_string_lossy().into_owned(),
        };
        let stage = staging_endpoint(&destination, id, "part");
        assert_eq!(Path::new(&stage.path).parent().unwrap(), parent);
        assert!(file_name_of(&stage.path).len() < 100);
        #[cfg(windows)]
        {
            let target = Endpoint {
                session: None,
                path: format!(r"C:\Users\user\nested\{}", "z".repeat(240)),
            };
            let stage = staging_endpoint(&target, id, "part");
            assert_eq!(
                Path::new(&stage.path).parent(),
                Path::new(&target.path).parent()
            );
            assert!(file_name_of(&stage.path).len() < 100);
        }
    }

    #[test]
    fn cancellation_cannot_be_reversed_by_a_late_pause_and_reserves_cleanup() {
        let registry = TransferRegistry::default();
        registry
            .register("test", Arc::new(AtomicBool::new(false)), None)
            .unwrap();
        registry.cancel("test");
        registry.pause("test");
        assert!(!registry.take_paused("test"));
        assert!(registry.is_active("test"));
        assert!(registry
            .register("test", Arc::new(AtomicBool::new(false)), None)
            .is_err());
        registry.release("test");
        assert!(!registry.is_active("test"));

        registry
            .register("test", Arc::new(AtomicBool::new(false)), None)
            .unwrap();
        registry.pause("test");
        registry.cancel("test");
        assert!(!registry.take_paused("test"));
    }

    #[test]
    fn duplicate_transfer_registration_cannot_replace_active_task() {
        let registry = TransferRegistry::default();
        let flag = Arc::new(AtomicBool::new(false));
        registry.register("same", flag.clone(), None).unwrap();
        assert!(registry
            .register("same", Arc::new(AtomicBool::new(false)), None)
            .is_err());
        registry.pause("same");
        assert!(flag.load(Ordering::SeqCst));
        assert!(registry.take_paused("same"));
        assert!(!registry.take_paused("same"));
    }

    #[test]
    fn target_directories_expand_home_and_relative_paths_without_guessing_a_session() {
        use super::requested_directory;
        for (input, expected) in [
            (None, "/home/test"),
            (Some(""), "/home/test"),
            (Some("~"), "/home/test"),
            (Some("~/project"), "/home/test/project"),
            (Some("project"), "/home/test/project"),
            (Some("/srv/project"), "/srv/project"),
        ] {
            assert_eq!(requested_directory("/home/test", input).unwrap(), expected);
        }
        assert!(requested_directory("/home/test", Some("a\0b")).is_err());
        assert!(requested_directory("/home/test", Some(&"a".repeat(32769))).is_err());
    }

    use super::*;

    fn transfer_event(id: &str, status: TransferStatus) -> TransferEvent {
        TransferEvent {
            id: id.into(),
            direction: "transfer",
            name: "file.txt".into(),
            transferred: 42,
            total: 42,
            status,
            phase: None,
            error: None,
        }
    }

    #[test]
    fn plugin_transfer_cancellation_cannot_target_user_or_other_runtime_transfers() {
        let registry = TransferRegistry::default();
        let user = Arc::new(AtomicBool::new(false));
        registry.register("user", user.clone(), None).unwrap();
        let own = Arc::new(AtomicBool::new(false));
        let (sender, receiver) = tokio::sync::watch::channel(false);
        registry
            .register(
                "own",
                own.clone(),
                Some(TransferOwner {
                    plugin_id: "one".into(),
                    generation: 7,
                    cancelled: sender,
                }),
            )
            .unwrap();
        assert!(!registry.cancel_owned("user", "one", 7));
        assert!(!registry.cancel_owned("own", "two", 7));
        assert!(!registry.cancel_owned("own", "one", 8));
        assert!(!own.load(Ordering::SeqCst));
        assert!(registry.cancel_owned("own", "one", 7));
        assert!(own.load(Ordering::SeqCst));
        assert!(*receiver.borrow());
        assert!(!user.load(Ordering::SeqCst));
        registry.complete(transfer_event("own", TransferStatus::Done));
        assert!(!registry.cancel_owned("own", "one", 7));
    }

    #[test]
    fn exited_plugin_cancels_only_its_own_generation_of_background_transfers() {
        let registry = TransferRegistry::default();
        let mut flags = Vec::new();
        for (id, plugin, generation) in [("a", "one", 7), ("b", "one", 8), ("c", "two", 7)] {
            let flag = Arc::new(AtomicBool::new(false));
            let (sender, _) = tokio::sync::watch::channel(false);
            registry
                .register(
                    id,
                    flag.clone(),
                    Some(TransferOwner {
                        plugin_id: plugin.into(),
                        generation,
                        cancelled: sender,
                    }),
                )
                .unwrap();
            flags.push(flag);
        }
        registry.cancel_plugin("one", 7);
        assert!(flags[0].load(Ordering::SeqCst));
        assert!(!flags[1].load(Ordering::SeqCst));
        assert!(!flags[2].load(Ordering::SeqCst));
    }

    #[test]
    fn limits_background_transfers_per_plugin_without_limiting_user_transfers() {
        let registry = TransferRegistry::default();
        for index in 0..9 {
            let (sender, _) = tokio::sync::watch::channel(false);
            let result = registry.register(
                &format!("plugin-{index}"),
                Arc::new(AtomicBool::new(false)),
                Some(TransferOwner {
                    plugin_id: "one".into(),
                    generation: 7,
                    cancelled: sender,
                }),
            );
            assert_eq!(result.is_ok(), index < 8);
        }
        assert!(registry
            .register("user", Arc::new(AtomicBool::new(false)), None)
            .is_ok());
        registry.complete(transfer_event("plugin-0", TransferStatus::Done));
        let (sender, _) = tokio::sync::watch::channel(false);
        assert!(registry
            .register(
                "replacement",
                Arc::new(AtomicBool::new(false)),
                Some(TransferOwner {
                    plugin_id: "one".into(),
                    generation: 8,
                    cancelled: sender,
                })
            )
            .is_ok());
    }

    #[test]
    fn transfer_status_keeps_progress_and_completed_results_private_to_the_owner_generation() {
        let registry = TransferRegistry::default();
        registry
            .register("user", Arc::new(AtomicBool::new(false)), None)
            .unwrap();
        let (sender, _) = tokio::sync::watch::channel(false);
        registry
            .register(
                "owned",
                Arc::new(AtomicBool::new(false)),
                Some(TransferOwner {
                    plugin_id: "one".into(),
                    generation: 7,
                    cancelled: sender,
                }),
            )
            .unwrap();
        assert_eq!(
            registry.status_owned("owned", "one", 7).unwrap().status,
            TransferStatus::Running
        );
        registry.update(&transfer_event("owned", TransferStatus::Running));
        assert_eq!(
            registry
                .status_owned("owned", "one", 7)
                .unwrap()
                .transferred,
            42
        );
        assert!(registry.status_owned("owned", "two", 7).is_none());
        assert!(registry.status_owned("owned", "one", 8).is_none());
        assert!(registry.status_owned("user", "one", 7).is_none());
        registry.complete(TransferEvent {
            transferred: 0,
            total: 0,
            ..transfer_event("owned", TransferStatus::Cancelled)
        });
        assert_eq!(
            registry.status_owned("owned", "one", 7).unwrap().status,
            TransferStatus::Cancelled
        );
        assert_eq!(
            registry
                .status_owned("owned", "one", 7)
                .unwrap()
                .transferred,
            42
        );
        assert!(registry.status_owned("owned", "one", 8).is_none());
        assert!(!registry.cancel_owned("owned", "one", 7));
        assert!(!registry.inner.lock().unwrap().active.contains_key("owned"));
    }

    #[test]
    fn completed_transfer_cache_evicts_old_results_and_excludes_user_transfers() {
        let registry = TransferRegistry::default();
        for index in 0..257 {
            let id = format!("done-{index}");
            let (sender, _) = tokio::sync::watch::channel(false);
            registry
                .register(
                    &id,
                    Arc::new(AtomicBool::new(false)),
                    Some(TransferOwner {
                        plugin_id: "one".into(),
                        generation: 7,
                        cancelled: sender,
                    }),
                )
                .unwrap();
            registry.complete(transfer_event(&id, TransferStatus::Done));
        }
        registry
            .register("user", Arc::new(AtomicBool::new(false)), None)
            .unwrap();
        registry.complete(transfer_event("user", TransferStatus::Done));
        assert_eq!(registry.inner.lock().unwrap().completed.len(), 256);
        assert!(registry.status_owned("done-0", "one", 7).is_none());
        assert!(registry.status_owned("done-1", "one", 7).is_some());
        assert!(registry.status_owned("done-256", "one", 7).is_some());
        assert!(registry.status_owned("done-256", "two", 7).is_none());
        assert!(registry.inner.lock().unwrap().active.is_empty());
    }

    #[tokio::test]
    async fn plugin_transfers_drop_in_flight_work_on_revoke_restricted_mode_and_restart() {
        use crate::plugins::security::PluginSecurity;
        struct Dropped(Arc<AtomicBool>);
        impl Drop for Dropped {
            fn drop(&mut self) {
                self.0.store(true, Ordering::SeqCst);
            }
        }
        for action in ["cancel", "revoke", "restrict", "restart"] {
            let db = crate::db::Database::in_memory().unwrap();
            let security = Arc::new(PluginSecurity::default());
            let permissions = vec!["fs.read".to_string(), "sftp.write".to_string()];
            let digest = "a".repeat(64);
            security
                .set_permissions(
                    &db,
                    "plugin",
                    digest.clone(),
                    &permissions,
                    Some(permissions.clone()),
                )
                .unwrap();
            let owner = security.lease("plugin", digest, permissions).unwrap();
            // Keep the cancellation channel open for the whole operation.
            let (sender, mut cancelled) = tokio::sync::watch::channel(false);
            let dropped = Arc::new(AtomicBool::new(false));
            let marker = dropped.clone();
            let (ready, started) = tokio::sync::oneshot::channel();
            let operation_security = security.clone();
            let keep_open = sender.clone();
            let task = tokio::spawn(async move {
                let _keep_open = keep_open;
                guard_plugin_transfer(&operation_security, &owner, &mut cancelled, async move {
                    let _marker = Dropped(marker);
                    let _ = ready.send(());
                    std::future::pending::<Outcome>().await
                })
                .await
            });
            started.await.unwrap();
            match action {
                "cancel" => {
                    sender.send_replace(true);
                }
                "revoke" => security
                    .set_permissions(&db, "plugin", String::new(), &[], None)
                    .unwrap(),
                "restrict" => security.set_restricted(&db, true, false).unwrap(),
                "restart" => security.invalidate_runtime("plugin"),
                _ => unreachable!(),
            }
            let result = tokio::time::timeout(std::time::Duration::from_millis(200), task)
                .await
                .unwrap()
                .unwrap();
            assert!(matches!(result, Outcome::Cancelled(0)), "{action}");
            assert!(
                dropped.load(Ordering::SeqCst),
                "in-flight transfer survived {action}"
            );
        }
    }

    #[tokio::test]
    async fn local_editor_checks_content_and_preserves_conflicts_and_deleted_files() {
        let root = temp_root("local-editor");
        let path = root.join("note.txt");
        std::fs::write(&path, "original").unwrap();
        let name = display_path(&path);
        assert_eq!(local_read_text(&name).await.unwrap().content, "original");
        local_write_text(&name, "short", "original").await.unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "short");
        std::fs::write(&path, "external").unwrap();
        assert_eq!(
            local_write_text(&name, "mine", "short")
                .await
                .unwrap_err()
                .to_string(),
            "editor.localFileChanged"
        );
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "external");
        std::fs::remove_file(&path).unwrap();
        assert!(local_write_text(&name, "mine", "external").await.is_err());
        assert!(!path.exists());
        std::fs::write(&path, b"binary\0text").unwrap();
        assert_eq!(
            local_read_text(&name).await.unwrap_err().to_string(),
            "sftp.binaryFile"
        );
        std::fs::write(&path, vec![b'x'; MAX_TEXT as usize + 1]).unwrap();
        assert_eq!(
            local_read_text(&name).await.unwrap_err().to_string(),
            "sftp.fileTooLarge"
        );
        assert!(local_read_text("relative.txt").await.is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn local_listing_reports_hidden_metadata_without_filtering_entries() {
        let root = temp_root("hidden-metadata");
        std::fs::write(root.join(".dotfile"), "hidden").unwrap();
        std::fs::write(root.join("visible.txt"), "visible").unwrap();
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .attributes(0x2)
                .open(root.join("windows-hidden.txt"))
                .unwrap();
        }
        let listing = local_list(Some(display_path(&root))).unwrap();
        assert!(
            listing
                .entries
                .iter()
                .find(|entry| entry.name == ".dotfile")
                .unwrap()
                .is_hidden
        );
        assert!(
            !listing
                .entries
                .iter()
                .find(|entry| entry.name == "visible.txt")
                .unwrap()
                .is_hidden
        );
        #[cfg(windows)]
        assert!(
            listing
                .entries
                .iter()
                .find(|entry| entry.name == "windows-hidden.txt")
                .unwrap()
                .is_hidden
        );
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn transfer_outcome_distinguishes_cancellation_from_failure_without_losing_progress() {
        let cancel = AtomicBool::new(true);
        assert!(matches!(
            Outcome::from_result(Err(AppError::Ssh(CANCELLED.into())), 0, &cancel),
            Outcome::Cancelled(0)
        ));
        assert!(matches!(
            Outcome::from_result(Err(AppError::Ssh(CANCELLED.into())), 1024, &cancel),
            Outcome::Cancelled(1024)
        ));
        // A late cancel request does not undo an operation that already completed.
        assert!(matches!(
            Outcome::from_result(Ok(()), 1024, &cancel),
            Outcome::Done(1024)
        ));
        cancel.store(false, Ordering::SeqCst);
        match Outcome::from_result(Err(AppError::Ssh("permission denied".into())), 512, &cancel) {
            Outcome::Failed(512, error) => assert_eq!(error, "permission denied"),
            _ => panic!("non-cancellation failure must preserve its error and progress"),
        }
    }

    mod protocol_io {
        use super::*;
        use russh_sftp::protocol::{Attrs, Data, FileAttributes, Handle, Status};
        use std::collections::HashMap;
        use std::io::{Read, Seek, SeekFrom, Write};
        use std::sync::atomic::AtomicUsize;
        use tokio::sync::Notify;

        struct RenameServer {
            advertised: bool,
            received: Arc<std::sync::Mutex<Vec<(String, Vec<u8>)>>>,
            result: StatusCode,
        }

        impl russh_sftp::server::Handler for RenameServer {
            type Error = StatusCode;
            fn unimplemented(&self) -> StatusCode {
                StatusCode::OpUnsupported
            }
            async fn init(
                &mut self,
                _version: u32,
                _extensions: HashMap<String, String>,
            ) -> Result<russh_sftp::protocol::Version, StatusCode> {
                let mut version = russh_sftp::protocol::Version::new();
                if self.advertised {
                    version
                        .extensions
                        .insert("posix-rename@openssh.com".into(), "1".into());
                }
                Ok(version)
            }
            async fn extended(
                &mut self,
                id: u32,
                request: String,
                data: Vec<u8>,
            ) -> Result<russh_sftp::protocol::Packet, StatusCode> {
                self.received.lock().unwrap().push((request, data));
                if self.result == StatusCode::Ok {
                    Ok(russh_sftp::protocol::Packet::Status(status(id)))
                } else {
                    Err(self.result)
                }
            }
        }

        #[tokio::test]
        async fn posix_replace_negotiates_and_encodes_paths_without_copying_data() {
            let received = Arc::new(std::sync::Mutex::new(Vec::new()));
            let (client, server) = tokio::io::duplex(8192);
            russh_sftp::server::run(
                server,
                RenameServer {
                    advertised: true,
                    received: received.clone(),
                    result: StatusCode::Ok,
                },
            )
            .await;
            let raw = russh_sftp::client::RawSftpSession::new(client);
            posix_replace(&raw, "/源 ' a", "/new\nname").await.unwrap();
            let calls = received.lock().unwrap();
            assert_eq!(calls.len(), 1);
            assert_eq!(calls[0].0, "posix-rename@openssh.com");
            let mut expected = Vec::new();
            for path in ["/源 ' a", "/new\nname"] {
                expected.extend_from_slice(&(path.len() as u32).to_be_bytes());
                expected.extend_from_slice(path.as_bytes());
            }
            assert_eq!(calls[0].1, expected);
        }

        #[tokio::test]
        async fn posix_replace_requires_the_extension_and_propagates_failures() {
            for (advertised, status_code, expected_requests) in [
                (false, StatusCode::Ok, 0),
                (true, StatusCode::PermissionDenied, 1),
            ] {
                let received = Arc::new(std::sync::Mutex::new(Vec::new()));
                let (client, server) = tokio::io::duplex(8192);
                russh_sftp::server::run(
                    server,
                    RenameServer {
                        advertised,
                        received: received.clone(),
                        result: status_code,
                    },
                )
                .await;
                let raw = russh_sftp::client::RawSftpSession::new(client);
                let error = posix_replace(&raw, "/a", "/b").await.unwrap_err();
                if !advertised {
                    assert_eq!(error.to_string(), "sftp.overwriteUnsupported");
                }
                assert_eq!(received.lock().unwrap().len(), expected_requests);
            }
        }

        #[derive(Default)]
        struct State {
            closes: AtomicUsize,
            fail_write: AtomicBool,
            fail_close: AtomicBool,
            delay_close: AtomicBool,
            close_started: Notify,
            release_close: Notify,
            read_bytes: std::sync::atomic::AtomicU64,
            max_read: AtomicUsize,
            hold_read: AtomicBool,
            read_started: Notify,
            release_read: Notify,
        }

        struct DiskServer {
            root: PathBuf,
            handles: HashMap<String, std::fs::File>,
            next: usize,
            state: Arc<State>,
        }

        fn status(id: u32) -> Status {
            Status {
                id,
                status_code: StatusCode::Ok,
                error_message: String::new(),
                language_tag: String::new(),
            }
        }

        fn io_status(error: std::io::Error) -> StatusCode {
            if error.kind() == std::io::ErrorKind::NotFound {
                StatusCode::NoSuchFile
            } else {
                StatusCode::Failure
            }
        }

        impl russh_sftp::server::Handler for DiskServer {
            type Error = StatusCode;

            fn unimplemented(&self) -> StatusCode {
                StatusCode::OpUnsupported
            }

            async fn open(
                &mut self,
                id: u32,
                filename: String,
                flags: OpenFlags,
                _attrs: FileAttributes,
            ) -> Result<Handle, StatusCode> {
                // Real OS files model the protocol's truncate/create/exclusive behavior.
                let file = std::fs::OpenOptions::new()
                    .read(flags.contains(OpenFlags::READ))
                    .write(flags.contains(OpenFlags::WRITE))
                    .create(flags.contains(OpenFlags::CREATE))
                    .create_new(flags.contains(OpenFlags::EXCLUDE))
                    .truncate(flags.contains(OpenFlags::TRUNCATE))
                    .open(self.root.join(filename))
                    .map_err(io_status)?;
                let handle = self.next.to_string();
                self.next += 1;
                self.handles.insert(handle.clone(), file);
                Ok(Handle { id, handle })
            }

            async fn write(
                &mut self,
                id: u32,
                handle: String,
                offset: u64,
                data: Vec<u8>,
            ) -> Result<Status, StatusCode> {
                if self.state.fail_write.load(Ordering::SeqCst) {
                    return Err(StatusCode::Failure);
                }
                let file = self.handles.get_mut(&handle).ok_or(StatusCode::Failure)?;
                file.seek(SeekFrom::Start(offset)).map_err(io_status)?;
                file.write_all(&data).map_err(io_status)?;
                Ok(status(id))
            }

            async fn read(
                &mut self,
                id: u32,
                handle: String,
                offset: u64,
                len: u32,
            ) -> Result<Data, StatusCode> {
                self.state.read_started.notify_one();
                if self.state.hold_read.load(Ordering::SeqCst) {
                    self.state.release_read.notified().await;
                }
                let file = self.handles.get_mut(&handle).ok_or(StatusCode::Failure)?;
                file.seek(SeekFrom::Start(offset)).map_err(io_status)?;
                let max = self.state.max_read.load(Ordering::SeqCst);
                let mut data = vec![
                    0;
                    if max == 0 {
                        len as usize
                    } else {
                        (len as usize).min(max)
                    }
                ];
                let read = file.read(&mut data).map_err(io_status)?;
                if read == 0 {
                    return Err(StatusCode::Eof);
                }
                data.truncate(read);
                self.state
                    .read_bytes
                    .fetch_add(read as u64, Ordering::SeqCst);
                Ok(Data { id, data })
            }

            async fn close(&mut self, id: u32, handle: String) -> Result<Status, StatusCode> {
                self.state.close_started.notify_one();
                if self.state.delay_close.load(Ordering::SeqCst) {
                    self.state.release_close.notified().await;
                }
                self.handles.remove(&handle).ok_or(StatusCode::Failure)?;
                self.state.closes.fetch_add(1, Ordering::SeqCst);
                if self.state.fail_close.load(Ordering::SeqCst) {
                    return Err(StatusCode::Failure);
                }
                Ok(status(id))
            }

            async fn stat(&mut self, id: u32, path: String) -> Result<Attrs, StatusCode> {
                let metadata = std::fs::metadata(self.root.join(path)).map_err(io_status)?;
                Ok(Attrs {
                    id,
                    attrs: FileAttributes::from(&metadata),
                })
            }

            async fn lstat(&mut self, id: u32, path: String) -> Result<Attrs, StatusCode> {
                let metadata =
                    std::fs::symlink_metadata(self.root.join(path)).map_err(io_status)?;
                let mut attrs = FileAttributes::from(&metadata);
                if local_metadata_is_link(&metadata) {
                    attrs.set_type(russh_sftp::protocol::FileMode::LNK);
                }
                Ok(Attrs { id, attrs })
            }

            async fn setstat(
                &mut self,
                id: u32,
                path: String,
                attrs: FileAttributes,
            ) -> Result<Status, StatusCode> {
                if let Some(length) = attrs.size {
                    std::fs::OpenOptions::new()
                        .write(true)
                        .open(self.root.join(path))
                        .map_err(io_status)?
                        .set_len(length)
                        .map_err(io_status)?;
                }
                Ok(status(id))
            }
        }

        async fn data_client(root: &Path, state: Arc<State>) -> Arc<range_io::DataSession> {
            let (client, server) = tokio::io::duplex(1024 * 1024);
            russh_sftp::server::run(
                server,
                DiskServer {
                    root: root.to_path_buf(),
                    handles: HashMap::new(),
                    next: 0,
                    state,
                },
            )
            .await;
            Arc::new(range_io::DataSession::new(client).await.unwrap())
        }

        #[tokio::test]
        async fn segmented_upload_download_and_remote_copy_preserve_bytes_without_prefetch_waste() {
            for (remote_source, remote_target) in [(false, true), (true, false), (true, true)] {
                let root = temp_root("segments-protocol");
                let content: Vec<_> = (0..5 * 1024 * 1024 + 17)
                    .map(|i| ((i * 73) % 251) as u8)
                    .collect();
                std::fs::write(root.join("source.bin"), &content).unwrap();
                let prefix = 65549;
                std::fs::write(root.join("target.part"), &content[..prefix]).unwrap();
                let state = Arc::new(State::default());
                // Valid SFTP servers may reply with less than the requested amount.
                state.max_read.store(16381, Ordering::SeqCst);
                let sessions = range_io::Sessions {
                    source: if remote_source {
                        Some(data_client(&root, state.clone()).await)
                    } else {
                        None
                    },
                    target: if remote_target {
                        Some(data_client(&root, state.clone()).await)
                    } else {
                        None
                    },
                };
                let endpoint = |name: &str, remote: bool| Endpoint {
                    session: remote.then(|| "test".into()),
                    path: if remote {
                        name.into()
                    } else {
                        display_path(&root.join(name))
                    },
                };
                let source = endpoint("source.bin", remote_source);
                let target = endpoint("target.part", remote_target);
                let files = range_io::Files::open(&sessions, &source, &target)
                    .await
                    .unwrap();
                let plan = segments::Plan {
                    workers: 4,
                    chunk: 1024 * 1024,
                    requests: 8,
                };
                let cancel = AtomicBool::new(false);
                let mut copied = 0;
                let mut offset = prefix as u64;
                while offset < content.len() as u64 {
                    let end = (offset + plan.chunk * plan.workers as u64).min(content.len() as u64);
                    segments::copy_window(&files, offset..end, plan, &cancel, |bytes| {
                        copied += bytes
                    })
                    .await
                    .unwrap();
                    offset = end;
                }
                files.close().await.unwrap();
                assert_eq!(std::fs::read(root.join("target.part")).unwrap(), content);
                assert_eq!(copied, (content.len() - prefix) as u64);
                assert_eq!(
                    state.read_bytes.load(Ordering::SeqCst),
                    if remote_source { copied } else { 0 }
                );
                assert_eq!(
                    state.closes.load(Ordering::SeqCst),
                    usize::from(remote_source) + usize::from(remote_target)
                );
                drop(sessions);
                std::fs::remove_dir_all(root).unwrap();
            }
        }

        #[tokio::test]
        async fn throttled_protocol_transfers_limit_all_workers_without_losing_bytes() {
            for (remote_source, remote_target) in [(false, true), (true, false), (true, true)] {
                let root = temp_root("limited-protocol");
                let content: Vec<_> = (0..64 * 1024 + 17).map(|i| (i % 251) as u8).collect();
                std::fs::write(root.join("source.bin"), &content).unwrap();
                std::fs::write(root.join("target.part"), []).unwrap();
                let state = Arc::new(State::default());
                let sessions = range_io::Sessions {
                    source: if remote_source {
                        Some(data_client(&root, state.clone()).await)
                    } else {
                        None
                    },
                    target: if remote_target {
                        Some(data_client(&root, state.clone()).await)
                    } else {
                        None
                    },
                };
                let endpoint = |name: &str, remote: bool| Endpoint {
                    session: remote.then(|| "test".into()),
                    path: if remote {
                        name.into()
                    } else {
                        display_path(&root.join(name))
                    },
                };
                let source = endpoint("source.bin", remote_source);
                let target = endpoint("target.part", remote_target);
                let controller = Arc::new(bandwidth::Controller::default());
                controller.register("test");
                controller.configure(256, 256);
                let files = range_io::Files::open(&sessions, &source, &target)
                    .await
                    .unwrap()
                    .with_throttle(bandwidth::Throttle {
                        controller,
                        id: "test".into(),
                    });
                let start = std::time::Instant::now();
                let mut progress = 0;
                segments::copy_window(
                    &files,
                    0..content.len() as u64,
                    segments::Plan {
                        workers: 4,
                        chunk: 16 * 1024,
                        requests: 8,
                    },
                    &AtomicBool::new(false),
                    |bytes| progress += bytes,
                )
                .await
                .unwrap();
                assert!(start.elapsed() >= std::time::Duration::from_millis(220));
                files.close().await.unwrap();
                assert_eq!(progress, content.len() as u64);
                assert_eq!(std::fs::read(root.join("target.part")).unwrap(), content);
                drop(sessions);
                std::fs::remove_dir_all(root).unwrap();
            }
        }

        #[tokio::test]
        async fn segmented_transfer_reports_write_and_close_failures() {
            let root = temp_root("segments-write-failure");
            std::fs::write(root.join("source.bin"), vec![7; 1024 * 1024]).unwrap();
            std::fs::write(root.join("target.part"), []).unwrap();
            let state = Arc::new(State::default());
            state.fail_write.store(true, Ordering::SeqCst);
            state.fail_close.store(true, Ordering::SeqCst);
            let sessions = range_io::Sessions {
                source: None,
                target: Some(data_client(&root, state.clone()).await),
            };
            let source = Endpoint {
                session: None,
                path: display_path(&root.join("source.bin")),
            };
            let target = Endpoint {
                session: Some("test".into()),
                path: "target.part".into(),
            };
            let files = range_io::Files::open(&sessions, &source, &target)
                .await
                .unwrap();
            let plan = segments::Plan {
                workers: 2,
                chunk: 512 * 1024,
                requests: 4,
            };
            assert!(segments::copy_window(
                &files,
                0..1024 * 1024,
                plan,
                &AtomicBool::new(false),
                |_| {}
            )
            .await
            .is_err());
            assert!(files.close().await.is_err());
            assert_eq!(state.closes.load(Ordering::SeqCst), 1);
            assert_eq!(
                std::fs::metadata(root.join("target.part")).unwrap().len(),
                0
            );
            drop(sessions);
            std::fs::remove_dir_all(root).unwrap();
        }

        #[tokio::test]
        async fn segmented_transfer_can_cancel_while_remote_reads_are_stalled() {
            let root = temp_root("segments-cancel");
            std::fs::write(root.join("source.bin"), vec![3; 1024 * 1024]).unwrap();
            std::fs::write(root.join("target.part"), []).unwrap();
            let state = Arc::new(State::default());
            state.hold_read.store(true, Ordering::SeqCst);
            let sessions = range_io::Sessions {
                source: Some(data_client(&root, state.clone()).await),
                target: None,
            };
            let source = Endpoint {
                session: Some("test".into()),
                path: "source.bin".into(),
            };
            let target = Endpoint {
                session: None,
                path: display_path(&root.join("target.part")),
            };
            let files = range_io::Files::open(&sessions, &source, &target)
                .await
                .unwrap();
            let cancel = AtomicBool::new(false);
            let plan = segments::Plan {
                workers: 2,
                chunk: 512 * 1024,
                requests: 4,
            };
            {
                let operation =
                    segments::copy_window(&files, 0..1024 * 1024, plan, &cancel, |_| {});
                tokio::pin!(operation);
                tokio::select! {
                    result = &mut operation => panic!("read should be pending: {result:?}"),
                    _ = state.read_started.notified() => {}
                }
                cancel.store(true, Ordering::SeqCst);
                let result =
                    tokio::time::timeout(std::time::Duration::from_millis(500), &mut operation)
                        .await
                        .unwrap();
                assert!(result.is_err());
            }
            state.hold_read.store(false, Ordering::SeqCst);
            state.release_read.notify_one();
            files.close().await.unwrap();
            drop(sessions);
            std::fs::remove_dir_all(root).unwrap();
        }

        async fn client(root: &Path, state: Arc<State>) -> Arc<SftpSession> {
            let (client, server) = tokio::io::duplex(1024 * 1024);
            russh_sftp::server::run(
                server,
                DiskServer {
                    root: root.to_path_buf(),
                    handles: HashMap::new(),
                    next: 0,
                    state,
                },
            )
            .await;
            Arc::new(
                SftpSession::new(client)
                    .await
                    .expect("SFTP protocol handshake"),
            )
        }

        #[tokio::test]
        async fn sftp_copy_and_transfer_reject_destination_links() {
            let root = temp_root("sftp-destination-link");
            let outside = root.join("outside");
            std::fs::create_dir(&outside).unwrap();
            std::fs::write(outside.join("preserved.txt"), "preserve").unwrap();
            std::fs::write(root.join("source.txt"), "overwrite").unwrap();
            let link = root.join("link");
            directory_link(&outside, &link);
            let sftp = client(&root, Arc::new(State::default())).await;
            let error = copy_remote_entry(&sftp, "source.txt", "link", true)
                .await
                .unwrap_err();
            assert!(error.to_string().contains("sftp.symlinkUnsupported"));
            let endpoint = Endpoint {
                session: Some("test".into()),
                path: "link".into(),
            };
            assert!(make_dir(&endpoint, Some(&sftp)).await.is_err());
            assert!(open_writer(&endpoint, Some(&sftp), true).await.is_err());
            assert_eq!(
                std::fs::read_to_string(outside.join("preserved.txt")).unwrap(),
                "preserve"
            );
            sftp.close().await.unwrap();
            #[cfg(windows)]
            std::fs::remove_dir(link).unwrap();
            #[cfg(unix)]
            std::fs::remove_file(link).unwrap();
            std::fs::remove_dir_all(root).unwrap();
        }

        #[tokio::test]
        async fn saving_shorter_and_empty_text_truncates_without_recreating_deleted_files() {
            let root = temp_root("protocol-save");
            let path = root.join("note.txt");
            std::fs::write(&path, "a long original file with a tail").unwrap();
            let state = Arc::new(State::default());
            let sftp = client(&root, state.clone()).await;
            write_remote_text(&sftp, "note.txt", "短\r\n")
                .await
                .unwrap();
            assert_eq!(std::fs::read(&path).unwrap(), "短\r\n".as_bytes());
            write_remote_text(&sftp, "note.txt", "").await.unwrap();
            assert!(std::fs::read(&path).unwrap().is_empty());
            std::fs::remove_file(&path).unwrap();
            assert!(write_remote_text(&sftp, "note.txt", "do not recreate")
                .await
                .is_err());
            assert!(!path.exists());
            assert_eq!(state.closes.load(Ordering::SeqCst), 2);
            sftp.close().await.unwrap();
            let _ = std::fs::remove_dir_all(root);
        }

        #[tokio::test]
        async fn text_reads_and_writes_wait_for_the_close_acknowledgement() {
            for read in [false, true] {
                let root = temp_root(if read {
                    "protocol-read-ack"
                } else {
                    "protocol-write-ack"
                });
                std::fs::write(root.join("note.txt"), "original").unwrap();
                let state = Arc::new(State::default());
                state.delay_close.store(true, Ordering::SeqCst);
                let sftp = client(&root, state.clone()).await;
                let task_client = sftp.clone();
                let operation = tokio::spawn(async move {
                    if read {
                        read_remote_text(&task_client, "note.txt").await.map(|_| ())
                    } else {
                        write_remote_text(&task_client, "note.txt", "saved").await
                    }
                });
                tokio::time::timeout(
                    std::time::Duration::from_secs(5),
                    state.close_started.notified(),
                )
                .await
                .expect("CLOSE request");
                assert!(
                    !operation.is_finished(),
                    "operation returned before CLOSE acknowledgement"
                );
                state.release_close.notify_one();
                operation.await.unwrap().unwrap();
                assert_eq!(state.closes.load(Ordering::SeqCst), 1);
                sftp.close().await.unwrap();
                let _ = std::fs::remove_dir_all(root);
            }
        }

        #[tokio::test]
        async fn text_save_reports_write_and_close_failures_and_closes_the_handle() {
            for failed_write in [false, true] {
                let root = temp_root(if failed_write {
                    "protocol-write-fail"
                } else {
                    "protocol-close-fail"
                });
                std::fs::write(root.join("note.txt"), "original").unwrap();
                let state = Arc::new(State::default());
                state.fail_write.store(failed_write, Ordering::SeqCst);
                state.fail_close.store(!failed_write, Ordering::SeqCst);
                let sftp = client(&root, state.clone()).await;
                assert!(write_remote_text(&sftp, "note.txt", "saved").await.is_err());
                assert_eq!(state.closes.load(Ordering::SeqCst), 1);
                sftp.close().await.unwrap();
                let _ = std::fs::remove_dir_all(root);
            }
        }

        #[tokio::test]
        async fn remote_copy_replaces_shorter_content_and_closes_both_handles() {
            let root = temp_root("protocol-copy");
            std::fs::write(root.join("from.txt"), "new").unwrap();
            std::fs::write(root.join("to.txt"), "long previous destination").unwrap();
            let state = Arc::new(State::default());
            let sftp = client(&root, state.clone()).await;
            copy_remote_entry(&sftp, "from.txt", "to.txt", true)
                .await
                .unwrap();
            assert_eq!(std::fs::read(root.join("to.txt")).unwrap(), b"new");
            assert_eq!(state.closes.load(Ordering::SeqCst), 2);
            state.fail_close.store(true, Ordering::SeqCst);
            assert!(copy_remote_entry(&sftp, "from.txt", "to.txt", true)
                .await
                .is_err());
            assert_eq!(state.closes.load(Ordering::SeqCst), 4);
            sftp.close().await.unwrap();
            let _ = std::fs::remove_dir_all(root);
        }

        #[tokio::test]
        async fn transfer_writer_finish_reports_remote_close_failure() {
            let root = temp_root("protocol-transfer-finish");
            let state = Arc::new(State::default());
            state.fail_close.store(true, Ordering::SeqCst);
            let sftp = client(&root, state.clone()).await;
            let endpoint = Endpoint {
                session: Some("mock".into()),
                path: "new.txt".into(),
            };
            let mut writer = open_writer(&endpoint, Some(&sftp), false).await.unwrap();
            writer.write_all(b"transferred bytes").await.unwrap();
            assert!(writer.finish().await.is_err());
            assert_eq!(state.closes.load(Ordering::SeqCst), 1);
            assert_eq!(
                std::fs::read(root.join("new.txt")).unwrap(),
                b"transferred bytes"
            );
            sftp.close().await.unwrap();
            let _ = std::fs::remove_dir_all(root);
        }
    }

    #[test]
    fn text_decode_preserves_utf8_bytes_bom_and_line_endings() {
        for original in ["", "hello\n", "\u{feff}中文 🌍\r\nnext\r\n", "literal �"] {
            let decoded = decode_text(original.as_bytes().to_vec()).expect("UTF-8 text");
            assert_eq!(decoded.content.as_bytes(), original.as_bytes());
            assert_eq!(decoded.size, original.len() as u64);
        }
    }

    #[test]
    fn text_decode_rejects_non_utf8_instead_of_replacing_bytes() {
        for bytes in [
            vec![0xc4, 0xe3, 0xba, 0xc3],
            vec![0xff, 0xfe, b'a', 0],
            vec![0xe4, 0xb8],
        ] {
            let error = decode_text(bytes).expect_err("unsupported encoding");
            assert_eq!(error.to_string(), "sftp.unsupportedEncoding");
        }
    }

    #[test]
    fn text_decode_rejects_binary_content_after_the_initial_preview() {
        let mut bytes = vec![b'a'; 8192];
        bytes.push(0);
        assert_eq!(
            decode_text(bytes).unwrap_err().to_string(),
            "sftp.binaryFile"
        );
    }

    #[test]
    fn text_decode_checks_the_actual_file_size() {
        let decoded = decode_text(vec![b'a'; MAX_TEXT as usize]).expect("at size limit");
        assert_eq!(decoded.size, MAX_TEXT);
        assert_eq!(
            decode_text(vec![b'a'; MAX_TEXT as usize + 1])
                .unwrap_err()
                .to_string(),
            "sftp.fileTooLarge"
        );
    }

    fn temp_root(name: &str) -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("tunnelde-sftp-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("root");
        root
    }

    fn directory_link(target: &Path, link: &Path) {
        #[cfg(unix)]
        std::os::unix::fs::symlink(target, link).unwrap();
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            let output = std::process::Command::new("cmd.exe")
                .args(["/C", "mklink", "/J"])
                .arg(link)
                .arg(target)
                .creation_flags(0x08000000)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
    }

    #[tokio::test]
    async fn measure_tree_counts_file_bytes_and_rejects_directory_links() {
        let root = temp_root("measure-tree");
        let source = root.join("source");
        let outside = root.join("outside");
        std::fs::create_dir_all(source.join("nested")).unwrap();
        std::fs::create_dir(&outside).unwrap();
        std::fs::write(source.join("one"), b"abc").unwrap();
        std::fs::write(source.join("nested/two"), b"12345").unwrap();
        std::fs::write(source.join("nested/empty"), b"").unwrap();
        std::fs::write(outside.join("unrelated"), b"do not count").unwrap();
        let endpoint = Endpoint {
            session: None,
            path: display_path(&source),
        };
        assert_eq!(measure(&endpoint, None).await.unwrap(), 8);
        let link = source.join("link");
        directory_link(&outside, &link);
        assert_eq!(
            measure(&endpoint, None).await.unwrap_err().to_string(),
            "sftp.symlinkUnsupported"
        );
        #[cfg(windows)]
        std::fs::remove_dir(link).unwrap();
        #[cfg(unix)]
        std::fs::remove_file(link).unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn recursive_copy_rejects_destination_directory_links_without_touching_outside() {
        let root = temp_root("destination-link");
        let source = root.join("source");
        let target = root.join("target");
        let outside = root.join("outside");
        std::fs::create_dir_all(source.join("nested")).unwrap();
        std::fs::create_dir_all(&target).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(source.join("nested/existing.txt"), "overwrite").unwrap();
        std::fs::write(source.join("nested/new.txt"), "create").unwrap();
        std::fs::write(outside.join("existing.txt"), "preserve").unwrap();
        let link = target.join("nested");
        directory_link(&outside, &link);
        assert!(local_copy(display_path(&source), display_path(&target), true).is_err());
        assert_eq!(
            std::fs::read_to_string(outside.join("existing.txt")).unwrap(),
            "preserve"
        );
        assert!(!outside.join("new.txt").exists());
        assert!(copy_local_entry(&link, &root.join("copy-of-link"), true).is_err());
        #[cfg(windows)]
        std::fs::remove_dir(link).unwrap();
        #[cfg(unix)]
        std::fs::remove_file(link).unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn transfer_writer_rejects_destination_directory_links() {
        let root = temp_root("transfer-link");
        let outside = root.join("outside");
        std::fs::create_dir(&outside).unwrap();
        let link = root.join("link");
        directory_link(&outside, &link);
        let endpoint = Endpoint {
            session: None,
            path: display_path(&link),
        };
        assert!(make_dir(&endpoint, None).await.is_err());
        assert!(open_writer(&endpoint, None, true).await.is_err());
        #[cfg(windows)]
        std::fs::remove_dir(link).unwrap();
        #[cfg(unix)]
        std::fs::remove_file(link).unwrap();
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn copies_and_removes_folders_recursively() {
        let root = temp_root("copy");
        let source = root.join("source");
        std::fs::create_dir_all(source.join("nested")).expect("nested");
        std::fs::write(source.join("a.txt"), "a").expect("a");
        std::fs::write(source.join("nested").join("b.txt"), "b").expect("b");

        let target = root.join("target");
        copy_local_entry(&source, &target, false).expect("copy");
        assert_eq!(std::fs::read_to_string(target.join("a.txt")).unwrap(), "a");
        assert_eq!(
            std::fs::read_to_string(target.join("nested").join("b.txt")).unwrap(),
            "b"
        );

        remove_local_entry(&target).expect("remove");
        assert!(!target.exists());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn creates_empty_files() {
        let root = temp_root("create");
        let file = root.join("note.txt");
        local_create_file(display_path(&file)).expect("create");
        assert!(file.exists());
        assert_eq!(std::fs::metadata(&file).unwrap().len(), 0);
        std::fs::write(&file, "keep me").expect("write");
        assert!(local_create_file(display_path(&file)).is_err());
        assert_eq!(std::fs::read_to_string(&file).unwrap(), "keep me");
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn rejects_unapproved_overwrite_and_recursive_self_copy() {
        let root = temp_root("safe-copy");
        let source = root.join("source");
        let target = root.join("target");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(source.join("a.txt"), "new").unwrap();
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("a.txt"), "old").unwrap();
        assert!(local_copy(display_path(&source), display_path(&target), false).is_err());
        assert_eq!(
            std::fs::read_to_string(target.join("a.txt")).unwrap(),
            "old"
        );
        assert!(local_copy(
            display_path(&source),
            display_path(&source.join("nested")),
            true
        )
        .is_err());
        assert!(!source.join("nested").exists());
        local_copy(display_path(&source), display_path(&target), true).unwrap();
        assert_eq!(
            std::fs::read_to_string(target.join("a.txt")).unwrap(),
            "new"
        );
        assert!(source.join("a.txt").exists());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn move_type_conflict_preserves_both_entries() {
        let root = temp_root("move-conflict");
        let source = root.join("source");
        let target = root.join("target");
        std::fs::write(&source, "original").unwrap();
        std::fs::create_dir(&target).unwrap();
        assert!(local_rename(display_path(&source), display_path(&target), true).is_err());
        assert_eq!(std::fs::read_to_string(&source).unwrap(), "original");
        assert!(target.is_dir());
        let _ = std::fs::remove_dir_all(root);
    }

    #[test]
    fn joins_remote_paths() {
        assert_eq!(join_remote("/home/user", "a"), "/home/user/a");
        assert_eq!(join_remote("/", "a"), "/a");
    }

    #[test]
    fn reads_the_entry_name_from_both_separators() {
        assert_eq!(file_name_of("/home/user/a.txt"), "a.txt");
        assert_eq!(file_name_of(r"C:\work\a.txt"), "a.txt");
        assert_eq!(file_name_of("/home/user/"), "user");
    }
}
