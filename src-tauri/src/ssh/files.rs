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

mod archive;
mod artifacts;
pub mod bandwidth;
mod batch;
mod compressed;
pub mod durable;
mod lifecycle;
#[cfg(windows)]
mod local_directory_move;
pub mod local_editor;
#[cfg(windows)]
mod local_move;
mod move_verification;
mod publication;
mod range_io;
mod remote_commit;
pub mod remote_editor;
mod remote_merge;
mod rename;
mod scan;
mod scheduler;
pub mod search;
mod segments;
mod verification;
use verification::{fingerprint_file, verify_prefix};

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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plugin_id: Option<String>,
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
    released: tokio::sync::Notify,
    pub bandwidth: Arc<bandwidth::Controller>,
    scheduler: scheduler::Scheduler,
}

struct CleanupReservation<'a> {
    registry: &'a TransferRegistry,
    id: &'a str,
}

impl Drop for CleanupReservation<'_> {
    fn drop(&mut self) {
        self.registry.release(self.id);
    }
}

#[derive(Default)]
struct TransferState {
    active: std::collections::HashMap<String, ActiveTransfer>,
    completed: std::collections::VecDeque<CompletedTransfer>,
    paused: std::collections::HashSet<String>,
}

struct ActiveTransfer {
    identity: String,
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
    fn reserve_cleanup<'a>(&'a self, id: &'a str) -> AppResult<CleanupReservation<'a>> {
        self.register(id, Arc::new(AtomicBool::new(false)), None)?;
        Ok(CleanupReservation { registry: self, id })
    }

    fn release(&self, id: &str) {
        if let Ok(mut state) = self.inner.lock() {
            state.active.remove(id);
            state.paused.remove(id);
            self.bandwidth.remove(id);
        }
        self.released.notify_waiters();
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
        self.register_with_limit(id, flag, owner, 0)
    }

    fn register_with_limit(
        &self,
        id: &str,
        flag: Arc<AtomicBool>,
        owner: Option<TransferOwner>,
        speed_limit_kib: u32,
    ) -> AppResult<()> {
        if speed_limit_kib > bandwidth::MAX_KIB {
            return Err(AppError::validation("sftp.invalidSpeedLimit"));
        }
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
        let plugin_id = owner.as_ref().map(|owner| owner.plugin_id.clone());
        state.active.insert(
            id.to_string(),
            ActiveTransfer {
                identity: uuid::Uuid::new_v4().to_string(),
                cancel: flag,
                owner,
                event: TransferEvent {
                    id: id.into(),
                    plugin_id,
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
        self.bandwidth.set_task(id, speed_limit_kib)?;
        Ok(())
    }

    fn update(&self, event: &mut TransferEvent) {
        if let Ok(mut state) = self.inner.lock() {
            if let Some(transfer) = state.active.get_mut(&event.id) {
                event.plugin_id = transfer.event.plugin_id.clone();
                transfer.event = event.clone();
            }
        }
    }

    fn complete(&self, mut event: TransferEvent) -> TransferEvent {
        if let Ok(mut state) = self.inner.lock() {
            if let Some(transfer) = state.active.remove(&event.id) {
                event.plugin_id = transfer.event.plugin_id;
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
        self.released.notify_waiters();
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
        self.cancel_owned_checked(id, plugin_id, generation, None)
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
        self.cancel_plugin_matching(plugin_id, |value| value == generation);
    }

    pub(crate) fn cancel_plugin_before(&self, plugin_id: &str, boundary: u64) {
        self.cancel_plugin_matching(plugin_id, |value| value < boundary);
    }

    fn cancel_plugin_matching(&self, plugin_id: &str, generation: impl Fn(u64) -> bool) {
        if let Ok(state) = self.inner.lock() {
            for transfer in state.active.values() {
                if transfer.owner.as_ref().is_some_and(|owner| {
                    owner.plugin_id == plugin_id && generation(owner.generation)
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
    let sftp = session(app, session_id)
        .await
        .map_err(|error| rename::context(&from, &to, error))?;
    let result = async {
        check_remote_destination(&sftp, &from, &to, overwrite).await?;
        if overwrite && remote_exists(&sftp, &to).await? {
            // Merge real directories using only server-side renames. Resolving
            // roots once also permits a user's parent directory symlink.
            if sftp
                .symlink_metadata(&from)
                .await
                .map_err(map_sftp)?
                .is_dir()
                && sftp.symlink_metadata(&to).await.map_err(map_sftp)?.is_dir()
            {
                let source = sftp.canonicalize(&from).await.map_err(map_sftp)?;
                let target = sftp.canonicalize(&to).await.map_err(map_sftp)?;
                let plan = remote_merge::Plan::prepare(&sftp, &source, &target).await?;
                let replacement = if plan.needs_replacement {
                    Some(remote_commit::Replacement::connect(app, session_id).await?)
                } else {
                    None
                };
                return plan.apply(&sftp, replacement.as_ref()).await;
            }
            return remote_replace(app, session_id, &from, &to).await;
        }
        rename::entry(&sftp, &from, &to).await
    }
    .await
    .map_err(|error| rename::context(&from, &to, error));
    let _ = sftp.close().await;
    result
}

// OpenSSH's extension maps to the server's atomic rename operation. In
// particular, never delete the destination as a workaround for SFTP v3.
async fn remote_replace(app: &AppHandle, session_id: &str, from: &str, to: &str) -> AppResult<()> {
    remote_commit::Replacement::connect(app, session_id)
        .await?
        .commit(from, to)
        .await
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
        return Err(AppError::validation("sftp.directoryMergeMoveUnavailable"));
    }
    commit_local_rename(Path::new(&from), Path::new(&to), overwrite)?;
    Ok(())
}

fn commit_local_rename(from: &Path, to: &Path, overwrite: bool) -> AppResult<()> {
    if overwrite {
        std::fs::rename(from, to)?;
    } else {
        // The destination can appear after check_local_destination. The commit
        // must enforce no replacement, including for dangling symbolic links.
        crate::platform::file_ops::rename_noreplace(from, to).map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                AppError::validation("sftp.alreadyExists")
            } else {
                AppError::from(error)
            }
        })?;
    }
    Ok(())
}

pub fn local_delete(path: String, _is_dir: bool) -> AppResult<()> {
    remove_local_entry(&PathBuf::from(path))
}

fn emit(app: &AppHandle, mut event: TransferEvent) {
    app.state::<AppState>().transfers.update(&mut event);
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
            plugin_id: None,
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
    Failed(u64, AppError),
}

impl Outcome {
    fn into_result(self) -> AppResult<()> {
        match self {
            Self::Done(_) => Ok(()),
            Self::Cancelled(_) => Err(AppError::Ssh(CANCELLED.into())),
            Self::Failed(_, error) => Err(error),
        }
    }

    fn from_result(result: AppResult<()>, transferred: u64, cancel: &AtomicBool) -> Self {
        match result {
            Ok(()) => Self::Done(transferred),
            Err(_) if cancel.load(Ordering::SeqCst) => Self::Cancelled(transferred),
            Err(error) => Self::Failed(transferred, error),
        }
    }
}

async fn finish(app: &AppHandle, id: &str, name: &str, outcome: &Outcome) {
    let state = app.state::<AppState>();
    let recovery = match outcome {
        Outcome::Failed(
            _,
            AppError::BackupRecovery {
                backup,
                destination,
            },
        )
        | Outcome::Failed(
            _,
            AppError::BackupUnrecognized {
                backup,
                destination,
            },
        )
        | Outcome::Failed(
            _,
            AppError::BackupPreserved {
                backup,
                destination,
            },
        ) => Some(durable::BackupRecovery {
            backup: backup.clone(),
            destination: destination.clone(),
        }),
        _ => None,
    };
    let artifact_recovery = match outcome {
        Outcome::Failed(_, AppError::TransferArtifactUnrecognized { path })
        | Outcome::Failed(_, AppError::TransferCreationUnconfirmed { path }) => Some(path.clone()),
        _ => None,
    };
    let has_recovery = recovery.is_some() || artifact_recovery.is_some();
    let event = match outcome {
        Outcome::Done(total) => TransferEvent {
            id: id.into(),
            plugin_id: None,
            direction: "transfer",
            name: name.into(),
            transferred: *total,
            total: *total,
            status: TransferStatus::Done,
            phase: None,
            error: None,
        },
        Outcome::Cancelled(transferred) => TransferEvent {
            id: id.into(),
            plugin_id: None,
            direction: "transfer",
            name: name.into(),
            transferred: *transferred,
            total: 0,
            status: TransferStatus::Cancelled,
            phase: None,
            error: None,
        },
        Outcome::Failed(transferred, error) => TransferEvent {
            id: id.into(),
            plugin_id: None,
            direction: "transfer",
            name: name.into(),
            transferred: *transferred,
            total: 0,
            status: TransferStatus::Failed,
            phase: None,
            error: Some(error.to_string()),
        },
    };
    let mut event = event;
    if event.status == TransferStatus::Cancelled && state.transfers.take_paused(id) {
        event.status = TransferStatus::Paused;
    }
    if let Ok(mut row) = durable::Journal::get(app, id) {
        event.plugin_id = row.plugin_id.clone();
        if row.plugin_id.is_some() && event.status == TransferStatus::Paused {
            event.status = TransferStatus::Cancelled;
        }
        if let Some(recovery) = recovery {
            row.backup_recovery = Some(recovery);
        }
        if let Some(path) = artifact_recovery {
            row.artifact_recovery = Some(path);
        }
        if event.status == TransferStatus::Cancelled
            || (row.plugin_id.is_some() && event.status == TransferStatus::Failed)
        {
            if let Some(error) = &event.error {
                tracing::warn!(transfer_id = id, plugin_id = row.plugin_id, %error,
                    "Plugin transfer failed; disposing its staging files");
            }
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
                    durable::record_cleanup_failure(&mut row, Some(error));
                    event.error = row.error.clone();
                    event.status = TransferStatus::CleanupPending;
                }
                Err(_) => {
                    tracing::warn!(transfer_id = id, "Cancelled transfer cleanup timed out");
                    durable::record_cleanup_failure(&mut row, None);
                    event.error = row.error.clone();
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
    if retry_cleanup || has_recovery {
        // Progress events omit recovery paths. Refresh the durable snapshot only
        // after the registry is released so recovery details reach the UI.
        let _ = app.emit("sftp://changed", ());
    }
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
    spawn_transfer_inner(app, from, to, remove_source, overwrite, None).map(|task| task.id)
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
    spawn_transfer_inner(app, from, to, false, overwrite, Some(owner)).map(|task| task.id)
}

/// Compatibility copy commands wait for the same journaled worker used by
/// asynchronous transfers. Dropping the reply never aborts a writer mid-IO.
pub(crate) struct TransferTask {
    pub id: String,
    completion: tokio::sync::oneshot::Receiver<AppResult<()>>,
    app: AppHandle,
}

struct CopyWaitCancellation {
    app: AppHandle,
    id: String,
}

impl Drop for CopyWaitCancellation {
    fn drop(&mut self) {
        // Signal the worker; never drop its future while writes or CLOSE replies
        // are outstanding. A completed worker has already released this ID.
        self.app.state::<AppState>().transfers.cancel(&self.id);
    }
}

impl TransferTask {
    pub async fn wait(self) -> AppResult<()> {
        let _cancellation = CopyWaitCancellation {
            app: self.app,
            id: self.id,
        };
        self.completion
            .await
            .map_err(|_| AppError::internal("sftp.copyInterrupted"))?
    }
}

pub(crate) fn start_copy(
    app: AppHandle,
    from: Endpoint,
    to: Endpoint,
    overwrite: bool,
    owner: Option<crate::plugins::security::Lease>,
) -> AppResult<TransferTask> {
    spawn_transfer_inner(app, from, to, false, overwrite, owner)
}

/// Only the UI's confirmed local rename fallback uses this copy-based move.
/// Other rename failures must retain their original atomic-rename semantics.
#[cfg(windows)]
pub(crate) fn start_local_move(
    app: AppHandle,
    from: String,
    to: String,
    overwrite: bool,
) -> AppResult<TransferTask> {
    spawn_transfer_inner(
        app,
        Endpoint {
            session: None,
            path: from,
        },
        Endpoint {
            session: None,
            path: to,
        },
        true,
        overwrite,
        None,
    )
}

fn spawn_transfer_inner(
    app: AppHandle,
    from: Endpoint,
    to: Endpoint,
    remove_source: bool,
    overwrite: bool,
    owner: Option<crate::plugins::security::Lease>,
) -> AppResult<TransferTask> {
    if from.session == to.session && from.path == to.path {
        return Err(AppError::validation("sftp.samePath"));
    }

    let id = uuid::Uuid::new_v4().to_string();
    let name = file_name_of(&from.path);
    let cancel = Arc::new(AtomicBool::new(false));
    let (cancel_sender, mut cancelled) = tokio::sync::watch::channel(false);
    let transfer_owner = owner.as_ref().map(|lease| TransferOwner {
        plugin_id: lease.id.clone(),
        generation: lease.generation,
        cancelled: cancel_sender,
    });
    // Claim the ID before writing its journal, so reconnect cleanup cannot
    // mistake a newly queued plugin task for an orphan from a previous process.
    app.state::<AppState>()
        .transfers
        .register(&id, cancel.clone(), transfer_owner)?;
    let recorded = (|| -> AppResult<()> {
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
                plugin_id: owner.as_ref().map(|lease| lease.id.clone()),
                retained_creation: false,
                retained_settlement: None,
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
                move_recovery: None,
                directory_move_manifest: None,
                overwrite,
                transferred: 0,
                total: 0,
                speed_limit_kib: 0,
                status: "running".into(),
                phase: None,
                error: None,
                backup_recovery: None,
                artifact_recovery: None,
                updated_at: crate::models::now_ms(),
            },
        )?;
        Ok(())
    })();
    if let Err(error) = recorded {
        app.state::<AppState>().transfers.release(&id);
        return Err(error);
    }
    progress(&app, &id, &name, 0, 0);
    let _ = app.emit("sftp://changed", ());

    let transfer_id = id.clone();
    let (completed, completion) = tokio::sync::oneshot::channel();
    let receipt_app = app.clone();
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
                durable: true,
                resuming: false,
            },
        );
        let outcome = if let Some(owner) = owner {
            let state = app_handle.state::<AppState>();
            guard_plugin_transfer(
                &state.plugins.security,
                &owner,
                &mut cancelled,
                &cancel,
                operation,
            )
            .await
        } else {
            operation.await
        };
        finish(&app_handle, &transfer_id, &name, &outcome).await;
        notify_transfer_files(&app_handle, &from, &to, remove_source);
        let _ = completed.send(outcome.into_result());
    });

    Ok(TransferTask {
        id,
        completion,
        app: receipt_app,
    })
}

pub(crate) fn resume_transfer(
    app: AppHandle,
    from: Endpoint,
    to: Endpoint,
    row: durable::DurableTransfer,
) -> AppResult<()> {
    row.require_user_control()?;
    if durable::needs_review(row.error.as_deref()) {
        return Err(AppError::validation(row.error.unwrap_or_default()));
    }
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
    app.state::<AppState>().transfers.register_with_limit(
        &id,
        cancel.clone(),
        None,
        row.speed_limit_kib,
    )?;
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
        finish(&app2, &id, &name, &out).await;
        notify_transfer_files(&app2, &from, &to, row.remove_source);
    });
    Ok(())
}

fn transfer_changed_sessions<'a>(
    from: &'a Endpoint,
    to: &'a Endpoint,
    remove_source: bool,
) -> Vec<Option<&'a str>> {
    let mut sessions = vec![to.session.as_deref()];
    if remove_source && from.session != to.session {
        sessions.push(from.session.as_deref());
    }
    sessions
}

fn notify_transfer_files(app: &AppHandle, from: &Endpoint, to: &Endpoint, remove_source: bool) {
    // Completion may follow a retry from the global task list, after its original
    // file view closed. Notify every affected source without depending on that view.
    // Failed and paused transfers can also have committed some directory entries.
    for session in transfer_changed_sessions(from, to, remove_source) {
        let _ = app.emit(
            "plugin://domain-changed",
            serde_json::json!({"domain":"files","sessionId":session}),
        );
    }
}

async fn guard_plugin_transfer(
    security: &crate::plugins::security::PluginSecurity,
    owner: &crate::plugins::security::Lease,
    cancelled: &mut tokio::sync::watch::Receiver<bool>,
    cancel: &AtomicBool,
    operation: impl std::future::Future<Output = Outcome>,
) -> Outcome {
    if *cancelled.borrow() {
        cancel.store(true, Ordering::SeqCst);
        return Outcome::Cancelled(0);
    }
    tokio::pin!(operation);
    tokio::select! {
        biased;
        _ = cancelled.changed() => {},
        _ = security.guard(owner, std::future::pending::<AppResult<()>>()) => {},
        outcome = operation.as_mut() => return outcome,
    }
    // Revoke further work, but let the existing writer settle its IO and
    // CLOSE before finish() deletes task-owned staging. Watching security
    // separately also avoids repolling a completed writer if its lease changes
    // at the same instant as its final result.
    cancel.store(true, Ordering::SeqCst);
    operation.await
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
    data_channels: Arc<tokio::sync::OnceCell<range_io::Sessions>>,
    batch_progress: Option<batch::Progress>,
    archives: Option<Arc<archive::Batcher>>,
}

impl<'a> Meter<'a> {
    async fn data_sessions(
        &self,
        from: &Endpoint,
        to: &Endpoint,
        from_sftp: Option<&SftpSession>,
        to_sftp: Option<&SftpSession>,
        cancel: &AtomicBool,
    ) -> AppResult<&range_io::Sessions> {
        self.data_channels
            .get_or_try_init(|| async {
                interruptible(
                    Some(cancel),
                    range_io::Sessions::open(
                        self.app,
                        from,
                        to,
                        &self.settings,
                        from_sftp,
                        to_sftp,
                        self.total,
                    ),
                )
                .await
            })
            .await
    }

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
            data_channels: Arc::new(tokio::sync::OnceCell::new()),
            batch_progress: None,
            archives: None,
        }
    }

    fn add(&mut self, bytes: u64) {
        self.transferred += bytes;
        if let Some(progress) = &self.batch_progress {
            progress.report(self.transferred);
            return;
        }
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
        if let Some(progress) = &self.batch_progress {
            progress.report(bytes);
            return Ok(());
        }
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
    // A ready operation can win before the interval's first tick. Do not even
    // poll it when cancellation was already requested (especially mutations).
    if cancel.is_some_and(|flag| flag.load(Ordering::SeqCst)) {
        return Err(AppError::Ssh(CANCELLED.into()));
    }
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
    /// A read handle has no writes to acknowledge. Let its queued CLOSE finish
    /// on the shared channel, without holding up a cancelled transfer.
    async fn finish_cancellable(self, cancel: &AtomicBool) -> AppResult<()> {
        interruptible(Some(cancel), self.finish()).await
    }

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
    /// Used only before the range/archive pipeline, while this handle has
    /// never written bytes. A delayed CLOSE cannot change the staging file.
    async fn finish_empty(self, cancel: &AtomicBool) -> AppResult<()> {
        match self {
            Self::Remote(_) => interruptible(Some(cancel), self.finish()).await,
            Self::Local(_) => self.finish().await,
        }
    }

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

#[derive(Debug, PartialEq)]
enum SourceMetadata {
    Directory,
    File(u64, Option<i64>),
}

/// Classify and stamp the same LSTAT result. Copy entry dispatch must not pay
/// another network round trip to fetch the metadata it just validated.
async fn inspect_source(
    endpoint: &Endpoint,
    sftp: Option<&SftpSession>,
) -> AppResult<SourceMetadata> {
    let (kind, modified) = match sftp {
        Some(handle) => {
            let metadata = handle
                .symlink_metadata(&endpoint.path)
                .await
                .map_err(map_sftp)?;
            (
                scan::remote_kind(&metadata)?
                    .ok_or_else(|| AppError::validation("sftp.fileMetadataMissing"))?,
                metadata.modified().ok().and_then(millis),
            )
        }
        None => {
            let metadata = tokio::fs::symlink_metadata(&endpoint.path).await?;
            (
                scan::local_kind(&metadata)?,
                metadata.modified().ok().and_then(millis),
            )
        }
    };
    Ok(match kind {
        scan::Kind::Directory => SourceMetadata::Directory,
        scan::Kind::File(size) => SourceMetadata::File(size, modified),
    })
}

async fn is_dir(endpoint: &Endpoint, sftp: Option<&SftpSession>) -> AppResult<bool> {
    Ok(matches!(
        inspect_source(endpoint, sftp).await?,
        SourceMetadata::Directory
    ))
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

async fn make_dir(
    endpoint: &Endpoint,
    sftp: Option<&SftpSession>,
    cancel: Option<&AtomicBool>,
) -> AppResult<()> {
    if cancel.is_some_and(|flag| flag.load(Ordering::SeqCst)) {
        return Err(AppError::Ssh(CANCELLED.into()));
    }
    match sftp {
        Some(handle) => {
            let metadata = interruptible(cancel, async {
                match handle.symlink_metadata(&endpoint.path).await {
                    Ok(metadata) => Ok(Some(metadata)),
                    Err(russh_sftp::client::error::Error::Status(status))
                        if status.status_code == StatusCode::NoSuchFile =>
                    {
                        Ok(None)
                    }
                    Err(error) => Err(map_sftp(error)),
                }
            })
            .await?;
            if cancel.is_some_and(|flag| flag.load(Ordering::SeqCst)) {
                return Err(AppError::Ssh(CANCELLED.into()));
            }
            match metadata {
                Some(metadata) if metadata.is_symlink() => {
                    Err(AppError::validation("sftp.symlinkUnsupported"))
                }
                Some(metadata) if metadata.is_dir() => Ok(()),
                Some(_) => Err(AppError::validation("sftp.typeConflict")),
                None => {
                    // Once sent, MKDIR must settle before cancellation is reported:
                    // a late acknowledgement must not race cleanup or resume.
                    handle.create_dir(&endpoint.path).await.map_err(map_sftp)?;
                    if cancel.is_some_and(|flag| flag.load(Ordering::SeqCst)) {
                        return Err(AppError::Ssh(CANCELLED.into()));
                    }
                    Ok(())
                }
            }
        }
        None => {
            reject_local_destination_link(Path::new(&endpoint.path))?;
            tokio::fs::create_dir_all(&endpoint.path).await?;
            if cancel.is_some_and(|flag| flag.load(Ordering::SeqCst)) {
                return Err(AppError::Ssh(CANCELLED.into()));
            }
            Ok(())
        }
    }
}

async fn measure(endpoint: &Endpoint, sftp: Option<&SftpSession>) -> AppResult<u64> {
    scan::measure(endpoint, sftp, 4).await
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
    create_writer(endpoint, sftp, overwrite).await
}

async fn create_writer(
    endpoint: &Endpoint,
    sftp: Option<&SftpSession>,
    overwrite: bool,
) -> AppResult<Writer> {
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

    let SourceMetadata::File(size, modified) =
        interruptible(Some(cancel), inspect_source(from, from_sftp)).await?
    else {
        make_dir(to, to_sftp, Some(cancel)).await?;
        let paths = interruptible(Some(cancel), children(from, from_sftp)).await?;
        // Overwrites reserve one commit channel per task. Keep their proven
        // sequential publication path until that protocol supports multiplexing.
        // Nested workers remain sequential to bound the entire directory task.
        if meter.settings.transfer_optimization
            && !overwrite
            && meter.batch_progress.is_none()
            && (from_sftp.is_some() || to_sftp.is_some())
            && paths.len() > 1
        {
            return copy_directory_batch(
                from, to, from_sftp, to_sftp, meter, cancel, paths, durable_id, resuming,
            )
            .await;
        }
        for path in paths {
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
    };
    if let Some(id) = durable_id {
        return durable_copy_file(
            from,
            to,
            from_sftp,
            to_sftp,
            meter,
            cancel,
            overwrite,
            id,
            resuming,
            (size, modified),
        )
        .await;
    }
    if from_sftp.is_some() || to_sftp.is_some() {
        open_writer(to, to_sftp, overwrite).await?.finish().await?;
        let channels = meter
            .data_channels
            .get_or_try_init(|| async {
                range_io::Sessions::open(
                    meter.app,
                    from,
                    to,
                    &meter.settings,
                    from_sftp,
                    to_sftp,
                    meter.total,
                )
                .await
            })
            .await?
            .clone();
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
        let closed = files.finish(copied.is_err()).await;
        return copied.and(closed);
    }
    let mut reader = open_reader(from, from_sftp).await?;
    let result = async {
        let mut writer = open_writer(to, to_sftp, overwrite).await?;
        let copied = async {
            let mut buffer = vec![0_u8; CHUNK];
            let throttle = meter.throttle();
            loop {
                if cancel.load(Ordering::SeqCst) {
                    return Err(AppError::Ssh(CANCELLED.into()));
                }
                let allowed = throttle
                    .acquire(bandwidth::Direction::Local, buffer.len(), cancel)
                    .await?;
                let read = reader.read(&mut buffer[..allowed]).await?;
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

#[allow(clippy::too_many_arguments)]
async fn copy_directory_batch(
    from: &Endpoint,
    to: &Endpoint,
    from_sftp: Option<&SftpSession>,
    to_sftp: Option<&SftpSession>,
    meter: &mut Meter<'_>,
    cancel: &Arc<AtomicBool>,
    paths: Vec<String>,
    durable_id: Option<&str>,
    resuming: bool,
) -> AppResult<()> {
    // Initialize once, lazily at the first validated regular file. Sampling a
    // directory child here could follow a link before copy_entry rejects it.
    let channels = meter.data_channels.clone();
    let archives = Arc::new(archive::Batcher::default());
    let app = meter.app;
    let id = meter.id;
    let name = meter.name;
    let total = meter.total;
    let base = meter.transferred;
    let mut settings = meter.settings.clone();
    let concurrency = match settings.transfer_concurrency {
        0 => 4,
        value => usize::from(value).clamp(1, 8),
    };
    // Share the existing per-task packet budget across files, instead of
    // multiplying segment parallelism by directory parallelism.
    settings.transfer_requests = match settings.transfer_requests {
        0 => 32 / concurrency as u16,
        value => value.min(64 / concurrency as u16),
    };
    settings.transfer_concurrency = 1;
    batch::run(
        paths,
        concurrency,
        cancel,
        |bytes| {
            let bytes = base + bytes;
            if bytes >= meter.transferred {
                meter.add(bytes - meter.transferred);
                Ok(())
            } else {
                meter.retain(bytes)
            }
        },
        |path, progress, stop| {
            let source = from.child(path);
            let destination = to.child(to.join(&file_name_of(&source.path)));
            let mut worker = Meter::new(app, id, name, total);
            worker.settings = settings.clone();
            worker.data_channels = channels.clone();
            worker.batch_progress = Some(progress);
            worker.archives = Some(archives.clone());
            async move {
                Box::pin(copy_entry(
                    &source,
                    &destination,
                    from_sftp,
                    to_sftp,
                    &mut worker,
                    &stop,
                    false,
                    durable_id,
                    resuming,
                ))
                .await
            }
        },
    )
    .await
}

async fn file_length(endpoint: &Endpoint, sftp: Option<&SftpSession>) -> AppResult<Option<u64>> {
    // Classify and read the same LSTAT result. A separate link probe doubles
    // metadata RTTs and can inspect a different object after path replacement.
    match sftp {
        Some(s) => match s.symlink_metadata(&endpoint.path).await {
            Ok(m) if m.is_symlink() => Err(AppError::validation("sftp.symlinkUnsupported")),
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
            Ok(m) if local_metadata_is_link(&m) => {
                Err(AppError::validation("sftp.symlinkUnsupported"))
            }
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
        Some(s) => rename::entry(s, &from.path, &to.path).await,
        None => {
            let source = PathBuf::from(&from.path);
            let destination = PathBuf::from(&to.path);
            tokio::task::spawn_blocking(move || {
                crate::platform::file_ops::rename_noreplace(&source, &destination)
            })
            .await
            .map_err(|e| AppError::internal(e.to_string()))?
            .map_err(|error| {
                if error.kind() == std::io::ErrorKind::AlreadyExists {
                    AppError::validation("sftp.alreadyExists")
                } else {
                    AppError::from(error)
                }
            })?;
            Ok(())
        }
    }
}
async fn source_stamp(
    endpoint: &Endpoint,
    sftp: Option<&SftpSession>,
) -> AppResult<(u64, Option<i64>)> {
    match inspect_source(endpoint, sftp).await? {
        SourceMetadata::File(size, modified) => Ok((size, modified)),
        SourceMetadata::Directory => Err(AppError::validation("sftp.resumeSourceChanged")),
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
    if interruptible(Some(cancel), file_length(backup, sftp))
        .await?
        .is_none()
    {
        return Ok(false);
    }
    let expected =
        backup_checkpoint(app, key)?.ok_or_else(|| AppError::validation("sftp.alreadyExists"))?;
    if fingerprint_file(backup, sftp, cancel).await? != expected {
        return Err(AppError::validation("sftp.resumePrefixMismatch"));
    }
    Ok(true)
}
/// Returns true only when the verified object was deleted through a held guard.
/// False keeps the object and its checkpoint for explicit review.
async fn remove_verified_backup(
    backup: &Endpoint,
    sftp: Option<&SftpSession>,
    expected: &BackupFingerprint,
    cancel: &AtomicBool,
) -> AppResult<bool> {
    #[cfg(windows)]
    if sftp.is_none() {
        let guard = crate::platform::guarded_file::GuardedFile::deletable(Path::new(&backup.path))?;
        return remove_guarded_backup(guard, expected, cancel)
            .await
            .map(|()| true);
    }
    if fingerprint_file(backup, sftp, cancel).await? != *expected {
        return Err(AppError::validation("sftp.resumePrefixMismatch"));
    }
    if cancel.load(Ordering::SeqCst) {
        return Err(AppError::Ssh(CANCELLED.into()));
    }
    // SFTP v3 and Unix unlink operate on a path, not the verified object.
    // Another stat or digest would only move the race. Keep the backup and
    // checkpoint so the caller can expose its location for explicit review.
    Ok(false)
}

#[cfg(windows)]
async fn remove_guarded_backup(
    guard: crate::platform::guarded_file::GuardedFile,
    expected: &BackupFingerprint,
    cancel: &AtomicBool,
) -> AppResult<()> {
    use sha2::{Digest, Sha256};
    let mut reader = tokio::fs::File::from_std(guard.reader()?);
    reader.seek(std::io::SeekFrom::Start(0)).await?;
    let metadata = reader.metadata().await?;
    let stamp = (metadata.len(), metadata.modified().ok().and_then(millis));
    if stamp != (expected.0, expected.1) {
        return Err(AppError::validation("sftp.resumePrefixMismatch"));
    }
    let mut digest = Sha256::new();
    let mut buffer = vec![0; CHUNK];
    loop {
        if cancel.load(Ordering::SeqCst) {
            return Err(AppError::Ssh(CANCELLED.into()));
        }
        let count = interruptible(Some(cancel), async {
            reader.read(&mut buffer).await.map_err(AppError::from)
        })
        .await?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    if format!("{:x}", digest.finalize()) != expected.2 {
        return Err(AppError::validation("sftp.resumePrefixMismatch"));
    }
    if cancel.load(Ordering::SeqCst) {
        return Err(AppError::Ssh(CANCELLED.into()));
    }
    // Close the cloned reader before disposition. All validation and deletion
    // refer to the same locked object, even if its parent path is redirected.
    drop(reader);
    guard.delete()?;
    Ok(())
}
async fn cleanup_backup(
    app: &AppHandle,
    key: &str,
    backup: &Endpoint,
    destination: &Endpoint,
    sftp: Option<&SftpSession>,
    cancel: &AtomicBool,
) -> AppResult<()> {
    let Some(expected) = backup_checkpoint(app, key)? else {
        return Ok(());
    };
    if interruptible(Some(cancel), file_length(backup, sftp))
        .await?
        .is_some()
    {
        match remove_verified_backup(backup, sftp, &expected, cancel).await {
            Ok(true) => {}
            Ok(false) => {
                return Err(AppError::BackupPreserved {
                    backup: backup.path.clone(),
                    destination: destination.path.clone(),
                })
            }
            Err(AppError::Validation(message)) if message == "sftp.resumePrefixMismatch" => {
                return Err(AppError::BackupUnrecognized {
                    backup: backup.path.clone(),
                    destination: destination.path.clone(),
                })
            }
            Err(error) => return Err(error),
        }
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
    stamp: (u64, Option<i64>),
) -> AppResult<()> {
    use sha2::{Digest, Sha256};
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
            let mut source = interruptible(Some(cancel), open_reader(from, from_sftp)).await?;
            if interruptible(Some(cancel), file_length(to, to_sftp)).await? != Some(stamp.0) {
                return Err(AppError::validation("sftp.resumePrefixMismatch"));
            }
            verify_prefix(&mut source, to, to_sftp, stamp.0, Some(cancel)).await?;
            source.finish_cancellable(cancel).await?;
            cleanup_backup(meter.app, &backup_key, &backup, to, to_sftp, cancel).await?;
            artifacts::confirm_publication(meter.app, id, to)?;
            artifacts::finish_staging(meter.app, id, to, to_sftp, cancel).await?;
            meter.add(stamp.0);
            return Ok(());
        }
    }
    let journal_app = meter.app;
    let save = |completed: bool| -> AppResult<()> {
        journal_app.state::<AppState>().db.with(|conn|{conn.execute("INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",rusqlite::params![&key,serde_json::to_string(&(stamp.0,stamp.1,completed))?,crate::models::now_ms()])?;Ok(())})
    };
    save(false)?;
    artifacts::record(meter.app, id, to, !resuming)?;
    let preparation_meter = &*meter;
    let (temp, recovering_publication) =
        artifacts::prepare_staging(meter.app, id, to, to_sftp, cancel, |directory| async move {
            let sessions = preparation_meter
                .data_sessions(from, to, from_sftp, to_sftp, cancel)
                .await?;
            let target = sessions
                .target
                .as_ref()
                .ok_or_else(|| AppError::internal("Missing staging data channel"))?;
            if cancel.load(Ordering::SeqCst) {
                return Err(AppError::Ssh(CANCELLED.into()));
            }
            artifacts::create_directory(
                preparation_meter.app,
                id,
                to,
                directory,
                target.clone(),
                cancel,
            )
            .await
        })
        .await?;
    #[cfg(windows)]
    let mut local_staging = artifacts::pin_local_staging(meter.app, id, to)?;
    let mut replay = None;
    if resuming {
        // A missing Windows staging file can reappear between the pin attempt
        // and recovery. Never trust such an unrecognized object by path.
        #[cfg(windows)]
        let can_recover_window = to_sftp.is_some() || local_staging.is_some();
        #[cfg(not(windows))]
        let can_recover_window = true;
        if can_recover_window {
            replay =
                artifacts::recover_window(meter.app, &key, stamp, &temp, to_sftp, Some(cancel))
                    .await?;
        }
    }
    let partial = if resuming {
        interruptible(Some(cancel), file_length(&temp, to_sftp)).await?
    } else {
        None
    };
    #[cfg(windows)]
    if to_sftp.is_none() && partial.is_some() && local_staging.is_none() {
        return Err(AppError::TransferArtifactUnrecognized { path: temp.path });
    }
    let published_length = if resuming && partial.is_none() {
        interruptible(Some(cancel), file_length(to, to_sftp)).await?
    } else {
        None
    };
    if recovering_publication && partial.is_none() && published_length != Some(stamp.0) {
        return Err(AppError::validation("sftp.resumePrefixMismatch"));
    }
    if published_length == Some(stamp.0) {
        phase(meter.app, id, "verifying");
        let mut completed = interruptible(Some(cancel), open_reader(from, from_sftp)).await?;
        let checked = verify_prefix(&mut completed, to, to_sftp, stamp.0, Some(cancel)).await;
        completed.finish_cancellable(cancel).await?;
        if checked.is_ok() {
            cleanup_backup(meter.app, &backup_key, &backup, to, to_sftp, cancel).await?;
            save(true)?;
            if recovering_publication {
                artifacts::confirm_publication(meter.app, id, to)?;
            }
            artifacts::finish_staging(meter.app, id, to, to_sftp, cancel).await?;
            meter.add(stamp.0);
            return Ok(());
        }
        // A lost publication acknowledgement may have been followed by a user
        // edit. Never silently overwrite that newer destination on Resume.
        if recovering_publication {
            checked?;
        }
    }
    // A sparse tail from an interrupted parallel window is not a completed
    // prefix. Retain the physical bytes and verify only the journalled prefix.
    let existing = replay
        .as_ref()
        .map_or(partial.unwrap_or(0), |window| window.start);
    if existing > stamp.0 {
        return Err(AppError::validation("sftp.resumePrefixMismatch"));
    }
    // Fresh remote copies open their data reader in the range/archive channel.
    // A metadata-channel reader is only needed for resume verification or the
    // local sequential path; opening and immediately closing it costs two RTTs.
    let mut reader = if existing > 0 || (from_sftp.is_none() && to_sftp.is_none()) {
        Some(interruptible(Some(cancel), open_reader(from, from_sftp)).await?)
    } else {
        None
    };
    if existing > 0 {
        phase(meter.app, id, "verifying");
        let verified = artifacts::resume_offset(
            reader
                .as_mut()
                .ok_or_else(|| AppError::internal("sftp.reader"))?,
            &temp,
            to_sftp,
            existing,
            cancel,
        )
        .await;
        if let Err(error) = verified {
            if let Some(reader) = reader {
                let _ = reader.finish_cancellable(cancel).await;
            }
            return Err(error);
        }
    }
    let destination_exists = interruptible(Some(cancel), file_length(to, to_sftp))
        .await?
        .is_some();
    if destination_exists && !overwrite {
        return Err(AppError::validation("sftp.alreadyExists"));
    }
    let remote_replacement = if overwrite && backup_checkpoint(meter.app, &backup_key)?.is_none() {
        if let Some(session_id) = &to.session {
            if interruptible(Some(cancel), file_length(&backup, to_sftp))
                .await?
                .is_some()
            {
                return Err(AppError::validation("sftp.alreadyExists"));
            }
            Some(
                interruptible(
                    Some(cancel),
                    remote_commit::Replacement::connect(meter.app, session_id),
                )
                .await?,
            )
        } else {
            None
        }
    } else {
        None
    };
    let isolated_create =
        partial.is_none() && artifacts::creation_pending(meter.app, id, to, true)?;
    if partial.is_none()
        && !isolated_create
        && interruptible(Some(cancel), file_length(&temp, to_sftp))
            .await?
            .is_some()
    {
        return Err(AppError::validation("sftp.alreadyExists"));
    }
    let mut writer = if partial.is_some() {
        match to_sftp {
            Some(s) => Writer::Remote(Box::new(
                interruptible(Some(cancel), async {
                    s.open_with_flags(&temp.path, OpenFlags::WRITE)
                        .await
                        .map_err(map_sftp)
                })
                .await?,
            )),
            None => Writer::Local(
                tokio::fs::OpenOptions::new()
                    .write(true)
                    .open(&temp.path)
                    .await?,
            ),
        }
    } else if isolated_create {
        // Exclusive CREATE inside the acknowledged private directory rejects
        // existing files and links atomically. Repeating LSTAT here cannot
        // make that check safer and costs several RTTs per small file.
        tracing::debug!(id, "Creating isolated transfer staging file");
        let writer = interruptible(Some(cancel), create_writer(&temp, to_sftp, false)).await?;
        artifacts::creation_pending(meter.app, id, to, false)?;
        writer
    } else {
        // Old journals do not own a removable parent that fences CREATE.
        interruptible(Some(cancel), reject_destination_link(&temp, to_sftp)).await?;
        create_writer(&temp, to_sftp, false).await?
    };
    #[cfg(windows)]
    artifacts::record_local_writer(
        meter.app,
        id,
        to,
        &writer,
        partial.is_none(),
        &mut local_staging,
    )?;
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
    if meter.batch_progress.is_none() {
        progress(meter.app, id, meter.name, meter.transferred, meter.total);
    }
    let plan = segments::Plan::for_file(
        &meter.settings,
        stamp.0.saturating_sub(existing),
        from_sftp.is_some() || to_sftp.is_some(),
    );
    let copied = if from_sftp.is_some() || to_sftp.is_some() {
        tracing::debug!(id, "Closing empty transfer staging writer");
        let (closed, read_closed) = tokio::join!(writer.finish_empty(cancel), async {
            match reader {
                Some(reader) => reader.finish_cancellable(cancel).await,
                None => Ok(()),
            }
        });
        closed?;
        read_closed?;
        parallel_copy_file(
            from,
            to,
            &temp,
            from_sftp,
            to_sftp,
            meter,
            cancel,
            &key,
            stamp,
            existing,
            plan,
            replay.map(|window| window.end),
        )
        .await
    } else {
        let mut reader = reader.ok_or_else(|| AppError::internal("sftp.reader"))?;
        let mut confirmed = existing;
        let mut attempted = existing;
        let result = async {
            let mut buf = vec![0; CHUNK];
            let throttle = meter.throttle();
            loop {
                if cancel.load(Ordering::SeqCst) {
                    return Err(AppError::Ssh(CANCELLED.into()));
                }
                let allowed = throttle
                    .acquire(bandwidth::Direction::Local, buf.len(), cancel)
                    .await?;
                let n = interruptible(Some(cancel), reader.read(&mut buf[..allowed])).await?;
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
        let read_closed = reader.finish_cancellable(cancel).await;
        if closed.is_ok() && (result.is_ok() || cancel.load(Ordering::SeqCst)) {
            // Closing flushes an interrupted sequential write too. Its resulting
            // length must lie within the source bytes submitted to this writer.
            if let Err(error) =
                artifacts::validate_partial_length(&temp, to_sftp, confirmed..=attempted).await
            {
                tracing::warn!(%error, "Cannot validate transfer partial length");
            }
        }
        result.and(closed).and(read_closed)
    };
    copied?;
    tracing::debug!(
        id,
        "Transfer data closed; validating source before publication"
    );
    if interruptible(Some(cancel), source_stamp(from, from_sftp)).await? != stamp {
        return Err(AppError::validation("sftp.resumeSourceChanged"));
    }
    if cancel.load(Ordering::SeqCst) {
        return Err(AppError::Ssh(CANCELLED.into()));
    }
    if let Some(replacement) = remote_replacement {
        // Only tasks without an earlier backup transaction enter this path.
        // A lost acknowledgement leaves the journal available for full target
        // verification on resume, rather than retrying a destructive fallback.
        artifacts::begin_publication(meter.app, id, to, &temp)?;
        tracing::debug!(id, "Publishing transfer staging file");
        interruptible(Some(cancel), replacement.commit(&temp.path, &to.path)).await?;
        save(true)?;
        artifacts::confirm_publication(meter.app, id, to)?;
        artifacts::finish_staging(meter.app, id, to, to_sftp, cancel).await?;
        return Ok(());
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
    if to_sftp.is_some() {
        artifacts::begin_publication(meter.app, id, to, &temp)?;
    }
    tracing::debug!(id, "Publishing transfer staging file");
    #[cfg(windows)]
    let committed = match local_staging.as_ref() {
        Some(guard) => guard
            .rename_noreplace(Path::new(&to.path))
            .map_err(|error| {
                if error.kind() == std::io::ErrorKind::AlreadyExists {
                    AppError::validation("sftp.alreadyExists")
                } else {
                    AppError::from(error)
                }
            }),
        None => publication::commit(&temp, to, to_sftp, cancel).await,
    };
    #[cfg(not(windows))]
    let committed = publication::commit(&temp, to, to_sftp, cancel).await;
    tracing::debug!(id, "Transfer publication returned");
    if let Err(e) = committed {
        if own_backup {
            // An existence check followed by rename could overwrite a file
            // created concurrently. Leave the journal and backup for recovery.
            return Err(AppError::BackupRecovery {
                backup: backup.path.clone(),
                destination: to.path.clone(),
            });
        }
        return Err(e);
    }
    #[cfg(windows)]
    drop(local_staging);
    cleanup_backup(meter.app, &backup_key, &backup, to, to_sftp, cancel).await?;
    save(true)?;
    if to_sftp.is_some() {
        artifacts::confirm_publication(meter.app, id, to)?;
    }
    artifacts::finish_staging(meter.app, id, to, to_sftp, cancel).await?;
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

async fn ensure_safe_transfer_move_source(
    from: &Endpoint,
    sftp: Option<&SftpSession>,
) -> AppResult<()> {
    if is_dir(from, sftp).await? {
        return Err(AppError::validation("sftp.directoryMoveUnavailable"));
    }
    Ok(())
}

/// A path that exists after source removal began may be a different file, even
/// when its size, timestamp and contents match the original. Legacy journals
/// also contain no destination digest proving a missing source was copied.
/// Recovery must therefore preserve both paths and require review.
async fn interrupted_move_error(from: &Endpoint, sftp: Option<&SftpSession>) -> AppError {
    let source_exists = match sftp {
        Some(sftp) => remote_exists(sftp, &from.path).await,
        None => match tokio::fs::symlink_metadata(&from.path).await {
            Ok(_) => Ok(true),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(error.into()),
        },
    };
    match source_exists {
        Ok(true) => AppError::validation("sftp.moveRecoverySourcePresent"),
        Ok(false) => AppError::validation("sftp.moveRecoveryUnverified"),
        Err(error) => error,
    }
}

async fn remove_endpoint(endpoint: &Endpoint, sftp: Option<&SftpSession>) -> AppResult<()> {
    match sftp {
        Some(handle) => remove_remote_entry(handle, &endpoint.path).await,
        None => remove_local_entry(&PathBuf::from(&endpoint.path)),
    }
}

/// Staging files and backups are always files. Do not inspect and recursively
/// delete a path that another client may have replaced with a directory.
async fn remove_transfer_file(endpoint: &Endpoint, sftp: Option<&SftpSession>) -> AppResult<()> {
    match sftp {
        Some(handle) => handle.remove_file(&endpoint.path).await.map_err(map_sftp),
        None => tokio::fs::remove_file(&endpoint.path)
            .await
            .map_err(Into::into),
    }
}

#[allow(clippy::too_many_arguments)]
async fn parallel_copy_file(
    from: &Endpoint,
    to: &Endpoint,
    temp: &Endpoint,
    from_sftp: Option<&SftpSession>,
    to_sftp: Option<&SftpSession>,
    meter: &mut Meter<'_>,
    cancel: &AtomicBool,
    key: &str,
    stamp: (u64, Option<i64>),
    mut offset: u64,
    plan: segments::Plan,
    mut replay_end: Option<u64>,
) -> AppResult<()> {
    let previous_files = meter.transferred.saturating_sub(offset);
    let channels = meter
        .data_sessions(from, temp, from_sftp, to_sftp, cancel)
        .await?
        .clone();
    if !channels.server_copy()
        && offset == 0
        && replay_end.is_none()
        && stamp.0 <= archive::MAX_FILE
    {
        if let Some(archives) = &meter.archives {
            let copied = archives
                .copy(
                    meter.app,
                    from,
                    to,
                    temp,
                    from_sftp,
                    to_sftp,
                    stamp.0,
                    meter.throttle(),
                    cancel,
                    meter.settings.transfer_compression,
                )
                .await?;
            if copied {
                interruptible(
                    Some(cancel),
                    artifacts::validate_partial_length(temp, to_sftp, stamp.0..=stamp.0),
                )
                .await?;
                meter.add(stamp.0);
                return Ok(());
            }
        }
    }
    let files = range_io::Files::open_cancellable(&channels, from, temp, cancel)
        .await?
        .with_throttle(meter.throttle());
    let result = async {
        while offset < stamp.0 {
            if cancel.load(Ordering::SeqCst) {
                return Err(AppError::Ssh(CANCELLED.into()));
            }
            let replaying = replay_end.is_some();
            let end = plan.window_end(offset, stamp.0, replay_end.take());
            artifacts::begin_window(meter.app, key, stamp, offset..end)?;
            if replaying {
                tracing::debug!(
                    id = meter.id,
                    offset,
                    end,
                    workers = plan.workers,
                    requests = plan.requests,
                    "Replaying unconfirmed transfer window"
                );
            }
            segments::copy_window(&files, offset..end, plan, cancel, |bytes| meter.add(bytes))
                .await?;
            interruptible(
                Some(cancel),
                artifacts::validate_partial_length(temp, to_sftp, end..=end),
            )
            .await?;
            artifacts::end_window(meter.app, key)?;
            offset = end;
        }
        Ok::<(), AppError>(())
    }
    .await;
    tracing::debug!(id = meter.id, "Closing transfer data handles");
    let closed = files.finish_cancellable(result.is_err(), cancel).await;
    // Keep an interrupted window journalled, including its maximum extent.
    // Resume rewrites it without issuing a potentially delayed truncate.
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
    let settings = app.state::<AppState>().settings();
    let archive_channels = options.durable && !options.overwrite && settings.transfer_optimization;
    let waiting = async {
        Ok(scheduler
            .reserve(
                from.session.as_deref(),
                to.session.as_deref(),
                options.durable && options.overwrite,
                archive_channels,
            )
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
                    Err(error) => return Outcome::Failed(0, error),
                };
                let total = measure(from, Some(&sftp)).await.unwrap_or(0);
                progress(app, id, name, 0, total);
                let result = async {
                    if cancel.load(Ordering::SeqCst) {
                        return Err(AppError::Ssh(CANCELLED.into()));
                    }
                    check_remote_destination(&sftp, &from.path, &to.path, overwrite).await?;
                    rename::entry(&sftp, &from.path, &to.path).await?;
                    Ok::<(), AppError>(())
                }
                .await
                .map_err(|error| rename::context(&from.path, &to.path, error));
                let _ = sftp.close().await;
                let transferred = if result.is_ok() { total } else { 0 };
                return Outcome::from_result(result, transferred, cancel);
            }
        }
    }

    let config = segments::config(&settings);
    let scan_concurrency = config.max_concurrent_reads;
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

    #[cfg(windows)]
    if durable && remove_source && from_sftp.is_none() && to_sftp.is_none() {
        let directory_move = match durable::Journal::get(app, id) {
            Ok(row) if row.directory_move_manifest.is_some() => Ok(true),
            Ok(row) if row.deleting_source => Ok(false),
            Ok(_) => is_dir(from, None).await,
            Err(error) => Err(error),
        };
        match directory_move {
            Ok(true) => {
                return local_directory_move::run(
                    app, from, to, id, name, cancel, overwrite, resuming,
                )
                .await
            }
            Ok(false) => {}
            Err(error) => return Outcome::from_result(Err(error), 0, cancel),
        }
    }

    if durable && resuming && remove_source {
        let recovery = match durable::Journal::get(app, id) {
            Ok(row) if row.deleting_source => {
                #[cfg(windows)]
                let result = if from_sftp.is_none() && to_sftp.is_none() {
                    if let Some(proof) = &row.move_recovery {
                        phase(app, id, "verifying");
                        local_move::recover(
                            Path::new(&from.path),
                            Path::new(&to.path),
                            proof,
                            cancel,
                        )
                        .await
                    } else {
                        Err(interrupted_move_error(from, None).await)
                    }
                } else {
                    Err(interrupted_move_error(from, from_sftp.as_ref()).await)
                };
                #[cfg(not(windows))]
                let result = Err(interrupted_move_error(from, from_sftp.as_ref()).await);
                Some((row.transferred, result))
            }
            Ok(_) => None,
            Err(error) => Some((0, Err(error))),
        };
        if let Some((transferred, result)) = recovery {
            if let Some(s) = from_sftp {
                let _ = tokio::time::timeout(std::time::Duration::from_secs(5), s.close()).await;
            }
            if let Some(s) = to_sftp {
                let _ = tokio::time::timeout(std::time::Duration::from_secs(5), s.close()).await;
            }
            return Outcome::from_result(result, transferred, cancel);
        }
    }
    if durable && remove_source {
        if let Err(error) = ensure_safe_transfer_move_source(from, from_sftp.as_ref()).await {
            if let Some(sftp) = from_sftp {
                let _ = tokio::time::timeout(std::time::Duration::from_secs(5), sftp.close()).await;
            }
            if let Some(sftp) = to_sftp {
                let _ = tokio::time::timeout(std::time::Duration::from_secs(5), sftp.close()).await;
            }
            return Outcome::from_result(Err(error), 0, cancel);
        }
    }
    let measured = interruptible(
        Some(cancel),
        scan::measure(from, from_sftp.as_ref(), scan_concurrency),
    )
    .await;
    let total = match measured {
        Ok(total) if !cancel.load(Ordering::SeqCst) => total,
        result => {
            if let Some(sftp) = from_sftp {
                let _ = tokio::time::timeout(std::time::Duration::from_secs(5), sftp.close()).await;
            }
            if let Some(sftp) = to_sftp {
                let _ = tokio::time::timeout(std::time::Duration::from_secs(5), sftp.close()).await;
            }
            let error = result
                .err()
                .unwrap_or_else(|| AppError::Ssh(CANCELLED.into()));
            return Outcome::from_result(Err(error), 0, cancel);
        }
    };
    progress(app, id, name, 0, total);

    let mut meter = Meter::new(app, id, name, total);
    meter.settings = settings;
    if let Ok(mut row) = durable::Journal::get(app, id) {
        row.total = total;
        let _ = durable::Journal::upsert(app, row);
    }
    let result = async {
        if !resuming && from.session == to.session {
            match from_sftp.as_ref() {
                Some(sftp) => {
                    interruptible(
                        Some(cancel),
                        check_remote_destination(sftp, &from.path, &to.path, overwrite),
                    )
                    .await?
                }
                None => {
                    check_local_destination(Path::new(&from.path), Path::new(&to.path), overwrite)?
                }
            }
        } else if !resuming && !overwrite {
            let exists = match to_sftp.as_ref() {
                Some(sftp) => interruptible(Some(cancel), remote_exists(sftp, &to.path)).await?,
                None => Path::new(&to.path).try_exists()?,
            };
            if exists {
                return Err(AppError::validation("sftp.alreadyExists"));
            }
        }
        // Lock both file objects across verification and deletion for a local
        // Windows move. Acquire the source before copying, so it cannot be
        // replaced with an identical-looking file while the transfer runs.
        #[cfg(windows)]
        let local_move = if durable && remove_source && from_sftp.is_none() && to_sftp.is_none() {
            Some(local_move::Source::open(Path::new(&from.path))?)
        } else {
            None
        };
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
            #[cfg(windows)]
            let verified_local_move = if let Some(source) = local_move {
                phase(app, id, "verifying");
                Some(source.verify(Path::new(&to.path), cancel).await?)
            } else {
                None
            };
            if durable {
                #[cfg(windows)]
                let guarded = verified_local_move.is_some();
                #[cfg(not(windows))]
                let guarded = false;
                if !guarded {
                    phase(app, id, "verifying");
                    move_verification::verify(
                        from,
                        to,
                        from_sftp.as_ref(),
                        to_sftp.as_ref(),
                        cancel,
                    )
                    .await?;
                }
                ensure_safe_transfer_move_source(from, from_sftp.as_ref()).await?;
                validate_move_source(app, id, from, to, from_sftp.as_ref()).await?;
                // Comparing complete contents does not make a later pathname
                // unlink conditional. Preserve both endpoints unless the file
                // objects remain guarded through source deletion.
                move_verification::require_guarded_deletion(guarded, cancel)?;
                if cancel.load(Ordering::SeqCst) {
                    return Err(AppError::Ssh(CANCELLED.into()));
                }
                let mut row = durable::Journal::get(app, id)?;
                row.deleting_source = true;
                row.transferred = meter.transferred;
                row.total = meter.total;
                #[cfg(windows)]
                if let Some(verified) = &verified_local_move {
                    row.move_recovery = Some(verified.proof().clone());
                }
                durable::Journal::commit_move_intent(app, row)?;
            }
            if cancel.load(Ordering::SeqCst) {
                return Err(AppError::Ssh(CANCELLED.into()));
            }
            if durable {
                #[cfg(windows)]
                if let Some(verified) = verified_local_move {
                    verified.delete(cancel)?;
                } else {
                    return Err(AppError::validation("sftp.moveSourceRetained"));
                }
                #[cfg(not(windows))]
                return Err(AppError::validation("sftp.moveSourceRetained"));
            } else {
                remove_endpoint(from, from_sftp.as_ref()).await?;
            }
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
#[cfg(test)]
pub async fn local_write_text(path: &str, content: &str, baseline: &str) -> AppResult<()> {
    // Internal tests run the same engine without an application journal.
    local_editor::save_without_app(path, content, baseline).await
}

fn validate_editor_text(path: &str, content: &str, baseline: &str) -> AppResult<()> {
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
    if !metadata.is_regular() {
        return Err(AppError::validation("sftp.notRegularFile"));
    }
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
    baseline: Option<&str>,
) -> AppResult<()> {
    if content.len() as u64 > MAX_TEXT || baseline.is_some_and(|s| s.len() as u64 > MAX_TEXT) {
        return Err(AppError::Ssh("sftp.fileTooLarge".into()));
    }
    if content.contains('\0') {
        return Err(AppError::Ssh("sftp.binaryFile".into()));
    }
    remote_editor::save(
        app.clone(),
        session_id.into(),
        path.into(),
        content.into(),
        baseline.map(str::to_owned),
    )
    .await
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
    #[test]
    fn copy_completion_preserves_structured_errors_and_cancellation() {
        assert!(Outcome::Done(7).into_result().is_ok());
        let cancelled = Outcome::Cancelled(3).into_result().unwrap_err();
        assert_eq!(cancelled.code(), "ssh");
        assert_eq!(cancelled.to_string(), CANCELLED);
        let error = AppError::BackupRecovery {
            backup: "preserved-backup".into(),
            destination: "original-target".into(),
        };
        let before = serde_json::to_value(&error).unwrap();
        let returned = Outcome::Failed(3, error).into_result().unwrap_err();
        assert!(matches!(returned, AppError::BackupRecovery { .. }));
        assert_eq!(serde_json::to_value(returned).unwrap(), before);
        let error = AppError::RemoteRename {
            from: "/source".into(),
            to: "/target".into(),
            reason: "denied".into(),
            status_code: Some(3),
            server_message: Some("Permission denied".into()),
        };
        let before = serde_json::to_value(&error).unwrap();
        assert_eq!(
            serde_json::to_value(Outcome::Failed(0, error).into_result().unwrap_err()).unwrap(),
            before
        );
    }

    #[test]
    fn transfer_changes_cover_modified_endpoints_without_duplicate_notifications() {
        let local = Endpoint {
            session: None,
            path: "local-file".into(),
        };
        let remote = Endpoint {
            session: Some("remote".into()),
            path: "/remote-file".into(),
        };
        let other = Endpoint {
            session: Some("other".into()),
            path: "/other-file".into(),
        };
        assert_eq!(
            transfer_changed_sessions(&local, &remote, false),
            vec![Some("remote")]
        );
        assert_eq!(
            transfer_changed_sessions(&remote, &local, false),
            vec![None]
        );
        assert_eq!(
            transfer_changed_sessions(&remote, &local, true),
            vec![None, Some("remote")]
        );
        assert_eq!(
            transfer_changed_sessions(&remote, &other, true),
            vec![Some("other"), Some("remote")]
        );
        assert_eq!(
            transfer_changed_sessions(&remote, &remote, true),
            vec![Some("remote")]
        );
        assert_eq!(transfer_changed_sessions(&local, &local, true), vec![None]);
    }

    #[tokio::test]
    async fn interrupted_move_never_resumes_deletion_or_assumes_success() {
        let root = temp_root("interrupted-move");
        let source = Endpoint {
            session: None,
            path: display_path(&root.join("source")),
        };
        let target = root.join("target");
        for target_contents in [b"original".as_slice(), b"modified", b""] {
            std::fs::write(&target, target_contents).unwrap();
            assert_eq!(
                interrupted_move_error(&source, None).await.to_string(),
                "sftp.moveRecoveryUnverified"
            );
            assert_eq!(std::fs::read(&target).unwrap(), target_contents);
            // Even an identical replacement must never be treated as the old
            // source and deleted by a retry.
            std::fs::write(&source.path, b"original").unwrap();
            assert_eq!(
                interrupted_move_error(&source, None).await.to_string(),
                "sftp.moveRecoverySourcePresent"
            );
            assert_eq!(std::fs::read(&source.path).unwrap(), b"original");
            assert_eq!(std::fs::read(&target).unwrap(), target_contents);
            std::fs::remove_file(&source.path).unwrap();
        }
        std::fs::remove_file(target).unwrap();
        // An absent destination is not evidence of completion either.
        assert_eq!(
            interrupted_move_error(&source, None).await.to_string(),
            "sftp.moveRecoveryUnverified"
        );
        std::fs::create_dir(&source.path).unwrap();
        assert_eq!(
            interrupted_move_error(&source, None).await.to_string(),
            "sftp.moveRecoverySourcePresent"
        );
        std::fs::remove_dir(&source.path).unwrap();
        std::fs::remove_dir(root).unwrap();
    }

    #[tokio::test]
    async fn interrupted_move_does_not_hide_source_inspection_errors() {
        let root = temp_root("interrupted-move-error");
        let file = root.join("file");
        std::fs::write(&file, b"preserved").unwrap();
        let source = Endpoint {
            session: None,
            path: format!("{}\0", display_path(&file)),
        };
        assert!(matches!(
            interrupted_move_error(&source, None).await,
            AppError::Io(_)
        ));
        assert_eq!(std::fs::read(&file).unwrap(), b"preserved");
        std::fs::remove_file(file).unwrap();
        std::fs::remove_dir(root).unwrap();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn interrupted_move_preserves_dangling_source_symlinks() {
        let root = temp_root("interrupted-move-link");
        let source = Endpoint {
            session: None,
            path: display_path(&root.join("source")),
        };
        std::os::unix::fs::symlink(root.join("missing"), &source.path).unwrap();
        assert_eq!(
            interrupted_move_error(&source, None).await.to_string(),
            "sftp.moveRecoverySourcePresent"
        );
        assert!(std::fs::symlink_metadata(&source.path)
            .unwrap()
            .is_symlink());
        std::fs::remove_file(source.path).unwrap();
        std::fs::remove_dir(root).unwrap();
    }

    #[test]
    fn local_move_commit_preserves_target_created_after_validation() {
        let root =
            std::env::temp_dir().join(format!("tunnelde-rename-race-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let source = root.join("source");
        let target = root.join("target");
        std::fs::write(&source, b"incoming").unwrap();
        check_local_destination(&source, &target, false).unwrap();
        std::fs::write(&target, b"independent").unwrap();
        assert_eq!(
            commit_local_rename(&source, &target, false)
                .unwrap_err()
                .to_string(),
            "sftp.alreadyExists"
        );
        assert_eq!(std::fs::read(&source).unwrap(), b"incoming");
        assert_eq!(std::fs::read(&target).unwrap(), b"independent");
        std::fs::remove_file(source).unwrap();
        std::fs::remove_file(target).unwrap();
        std::fs::remove_dir(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn local_move_preserves_dangling_target_link() {
        let root =
            std::env::temp_dir().join(format!("tunnelde-rename-link-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let source = root.join("source");
        let target = root.join("target");
        std::fs::write(&source, b"incoming").unwrap();
        std::os::unix::fs::symlink("missing", &target).unwrap();
        assert_eq!(
            local_rename(display_path(&source), display_path(&target), false)
                .unwrap_err()
                .to_string(),
            "sftp.alreadyExists"
        );
        assert_eq!(std::fs::read(&source).unwrap(), b"incoming");
        assert_eq!(std::fs::read_link(&target).unwrap(), Path::new("missing"));
        assert!(!root.join("missing").exists());
        std::fs::remove_file(source).unwrap();
        std::fs::remove_file(target).unwrap();
        std::fs::remove_dir(root).unwrap();
    }

    #[test]
    fn local_move_file_replacement_requires_explicit_overwrite() {
        let root = std::env::temp_dir().join(format!(
            "tunnelde-rename-overwrite-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir(&root).unwrap();
        let source = root.join("source");
        let target = root.join("target");
        std::fs::write(&source, b"incoming").unwrap();
        std::fs::write(&target, b"original").unwrap();
        assert!(local_rename(display_path(&source), display_path(&target), false).is_err());
        assert_eq!(std::fs::read(&target).unwrap(), b"original");
        // Windows std::fs::rename supports replacing an existing file too.
        local_rename(display_path(&source), display_path(&target), true).unwrap();
        assert!(!source.exists());
        assert_eq!(std::fs::read(&target).unwrap(), b"incoming");
        std::fs::remove_file(target).unwrap();
        std::fs::remove_dir(root).unwrap();
    }

    #[test]
    fn local_move_to_new_directory_still_uses_rename() {
        let root = std::env::temp_dir().join(format!("tunnelde-rename-{}", uuid::Uuid::new_v4()));
        let source = root.join("source");
        let target = root.join("target");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(source.join("file.txt"), b"content").unwrap();
        local_rename(display_path(&source), display_path(&target), false).unwrap();
        assert!(!source.exists());
        assert_eq!(std::fs::read(target.join("file.txt")).unwrap(), b"content");
        std::fs::remove_file(target.join("file.txt")).unwrap();
        std::fs::remove_dir(target).unwrap();
        std::fs::remove_dir(root).unwrap();
    }

    #[test]
    fn local_move_rejects_directory_merge_without_modifying_either_tree() {
        let root =
            std::env::temp_dir().join(format!("tunnelde-merge-guard-{}", uuid::Uuid::new_v4()));
        let source = root.join("source");
        let target = root.join("target");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(source.join("one.txt"), b"source").unwrap();
        std::fs::write(target.join("two.txt"), b"target").unwrap();
        assert_eq!(
            local_rename(display_path(&source), display_path(&target), true)
                .unwrap_err()
                .to_string(),
            "sftp.directoryMergeMoveUnavailable"
        );
        assert_eq!(std::fs::read(source.join("one.txt")).unwrap(), b"source");
        assert_eq!(std::fs::read(target.join("two.txt")).unwrap(), b"target");
        std::fs::remove_file(source.join("one.txt")).unwrap();
        std::fs::remove_file(target.join("two.txt")).unwrap();
        std::fs::remove_dir(source).unwrap();
        std::fs::remove_dir(target).unwrap();
        std::fs::remove_dir(root).unwrap();
    }

    #[tokio::test]
    async fn transfer_move_rejects_directories_without_removing_source() {
        let root =
            std::env::temp_dir().join(format!("tunnelde-move-guard-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let file = root.join("file.txt");
        std::fs::write(&file, b"preserved").unwrap();
        let directory = Endpoint {
            session: None,
            path: display_path(&root),
        };
        let single_file = Endpoint {
            session: None,
            path: display_path(&file),
        };
        assert_eq!(
            ensure_safe_transfer_move_source(&directory, None)
                .await
                .unwrap_err()
                .to_string(),
            "sftp.directoryMoveUnavailable"
        );
        assert!(ensure_safe_transfer_move_source(&single_file, None)
            .await
            .is_ok());
        assert_eq!(std::fs::read(&file).unwrap(), b"preserved");
        std::fs::remove_file(file).unwrap();
        std::fs::remove_dir(root).unwrap();
    }

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
    async fn transfer_artifact_removal_preserves_replacement_directories() {
        let root = std::env::temp_dir().join(format!("tunnelde-artifact-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let artifact = Endpoint {
            session: None,
            path: display_path(&root.join("artifact")),
        };
        std::fs::create_dir(&artifact.path).unwrap();
        let independent = Path::new(&artifact.path).join("independent.txt");
        std::fs::write(&independent, b"preserve directory content").unwrap();
        assert!(remove_transfer_file(&artifact, None).await.is_err());
        assert_eq!(
            std::fs::read(&independent).unwrap(),
            b"preserve directory content"
        );
        std::fs::remove_file(&independent).unwrap();
        std::fs::remove_dir(&artifact.path).unwrap();
        std::fs::write(&artifact.path, b"partial file").unwrap();
        remove_transfer_file(&artifact, None).await.unwrap();
        assert!(!Path::new(&artifact.path).exists());
        std::fs::remove_dir(root).unwrap();
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn guarded_backup_cleanup_uses_only_the_verified_file_handle() {
        use crate::platform::guarded_file::GuardedFile;
        let root =
            std::env::temp_dir().join(format!("tunnelde-backup-guard-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let backup = Endpoint {
            session: None,
            path: display_path(&root.join("backup")),
        };
        let replacement = root.join("independent");
        std::fs::write(&backup.path, vec![7; CHUNK * 2 + 19]).unwrap();
        std::fs::write(&replacement, b"independent replacement").unwrap();
        let cancel = AtomicBool::new(false);
        let expected = fingerprint_file(&backup, None, &cancel).await.unwrap();
        let guard = GuardedFile::deletable(Path::new(&backup.path)).unwrap();
        assert!(std::fs::rename(&replacement, &backup.path).is_err());
        assert!(std::fs::remove_file(&backup.path).is_err());
        assert!(std::fs::write(&backup.path, b"changed").is_err());
        remove_guarded_backup(guard, &expected, &cancel)
            .await
            .unwrap();
        assert!(!Path::new(&backup.path).exists());
        assert_eq!(
            std::fs::read(&replacement).unwrap(),
            b"independent replacement"
        );
        std::fs::remove_file(replacement).unwrap();
        std::fs::remove_dir(root).unwrap();
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn guarded_backup_cleanup_preserves_changes_and_cancellation() {
        let root =
            std::env::temp_dir().join(format!("tunnelde-backup-cancel-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let backup = Endpoint {
            session: None,
            path: display_path(&root.join("backup")),
        };
        let cancel = AtomicBool::new(false);
        std::fs::write(&backup.path, b"original").unwrap();
        let mut expected = fingerprint_file(&backup, None, &cancel).await.unwrap();
        std::fs::write(&backup.path, b"modified").unwrap();
        // Equal lengths and timestamps must not bypass content validation.
        expected.1 = std::fs::metadata(&backup.path)
            .unwrap()
            .modified()
            .ok()
            .and_then(millis);
        assert_eq!(
            remove_verified_backup(&backup, None, &expected, &cancel)
                .await
                .unwrap_err()
                .to_string(),
            "sftp.resumePrefixMismatch"
        );
        assert_eq!(std::fs::read(&backup.path).unwrap(), b"modified");
        expected = fingerprint_file(&backup, None, &cancel).await.unwrap();
        cancel.store(true, Ordering::SeqCst);
        assert_eq!(
            remove_verified_backup(&backup, None, &expected, &cancel)
                .await
                .unwrap_err()
                .to_string(),
            CANCELLED
        );
        assert_eq!(std::fs::read(&backup.path).unwrap(), b"modified");
        // Cancellation releases the guard; a subsequent retry can proceed.
        cancel.store(false, Ordering::SeqCst);
        remove_verified_backup(&backup, None, &expected, &cancel)
            .await
            .unwrap();
        assert!(!Path::new(&backup.path).exists());
        std::fs::remove_dir(root).unwrap();
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn guarded_backup_cleanup_retries_after_an_existing_writer_closes() {
        let root =
            std::env::temp_dir().join(format!("tunnelde-backup-writer-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let backup = Endpoint {
            session: None,
            path: display_path(&root.join("backup")),
        };
        let cancel = AtomicBool::new(false);
        std::fs::write(&backup.path, b"preserved backup").unwrap();
        let expected = fingerprint_file(&backup, None, &cancel).await.unwrap();
        let writer = std::fs::OpenOptions::new()
            .write(true)
            .open(&backup.path)
            .unwrap();
        assert!(remove_verified_backup(&backup, None, &expected, &cancel)
            .await
            .is_err());
        assert_eq!(std::fs::read(&backup.path).unwrap(), b"preserved backup");
        drop(writer);
        remove_verified_backup(&backup, None, &expected, &cancel)
            .await
            .unwrap();
        assert!(!Path::new(&backup.path).exists());
        std::fs::remove_dir(root).unwrap();
    }

    #[cfg(not(windows))]
    #[tokio::test]
    async fn backup_cleanup_preserves_unix_objects_and_open_writers() {
        let root =
            std::env::temp_dir().join(format!("tunnelde-backup-retained-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        let backup = Endpoint {
            session: None,
            path: display_path(&root.join("backup")),
        };
        std::fs::write(&backup.path, b"old destination").unwrap();
        let cancel = AtomicBool::new(false);
        let expected = fingerprint_file(&backup, None, &cancel).await.unwrap();
        let writer = std::fs::OpenOptions::new()
            .write(true)
            .open(&backup.path)
            .unwrap();
        assert!(!remove_verified_backup(&backup, None, &expected, &cancel)
            .await
            .unwrap());
        assert_eq!(std::fs::read(&backup.path).unwrap(), b"old destination");
        // Keep the original inode open while putting an identical file at its
        // former path. A matching digest is still not permission to unlink it.
        let modified = writer.metadata().unwrap().modified().unwrap();
        std::fs::rename(&backup.path, root.join("original")).unwrap();
        std::fs::write(&backup.path, b"old destination").unwrap();
        std::fs::File::options()
            .write(true)
            .open(&backup.path)
            .unwrap()
            .set_times(std::fs::FileTimes::new().set_modified(modified))
            .unwrap();
        assert!(!remove_verified_backup(&backup, None, &expected, &cancel)
            .await
            .unwrap());
        assert_eq!(std::fs::read(&backup.path).unwrap(), b"old destination");
        assert_eq!(
            std::fs::read(root.join("original")).unwrap(),
            b"old destination"
        );
        cancel.store(true, Ordering::SeqCst);
        assert!(remove_verified_backup(&backup, None, &expected, &cancel)
            .await
            .is_err());
        drop(writer);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
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

    #[tokio::test]
    async fn abandoned_cleanup_releases_its_claim_and_wakes_reconnect_waiters() {
        let registry = Arc::new(TransferRegistry::default());
        let worker = registry.clone();
        let (entered, ready) = tokio::sync::oneshot::channel();
        let task = tokio::spawn(async move {
            let _reservation = worker.reserve_cleanup("dispose").unwrap();
            entered.send(()).unwrap();
            std::future::pending::<()>().await;
        });
        ready.await.unwrap();
        assert!(registry.reserve_cleanup("dispose").is_err());
        let released = registry.released.notified();
        tokio::pin!(released);
        released.as_mut().enable();
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        tokio::time::timeout(std::time::Duration::from_millis(250), released)
            .await
            .expect("cleanup cancellation lost the reconnect notification");
        assert!(!registry.is_active("dispose"));
        let reservation = registry.reserve_cleanup("dispose").unwrap();
        assert!(registry.is_active("dispose"));
        drop(reservation);
        assert!(!registry.is_active("dispose"));
    }

    #[tokio::test]
    async fn completed_transfer_wakes_an_enabled_but_unpolled_cleanup_waiter() {
        let registry = TransferRegistry::default();
        registry
            .register("dispose", Arc::new(AtomicBool::new(false)), None)
            .unwrap();
        let released = registry.released.notified();
        tokio::pin!(released);
        released.as_mut().enable();
        registry.complete(transfer_event("dispose", TransferStatus::Cancelled));
        tokio::time::timeout(std::time::Duration::from_millis(250), released)
            .await
            .expect("completion between registration and polling lost the wakeup");
        assert!(!registry.is_active("dispose"));
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
            plugin_id: None,
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
    fn delayed_transfer_cleanup_keeps_new_runtime_and_user_transfers() {
        let registry = TransferRegistry::default();
        let mut flags = Vec::new();
        for (id, plugin, generation) in [
            ("old", Some("one"), 7),
            ("new", Some("one"), 8),
            ("newer", Some("one"), 9),
            ("other", Some("two"), 7),
            ("user", None, 0),
        ] {
            let flag = Arc::new(AtomicBool::new(false));
            let (sender, _) = tokio::sync::watch::channel(false);
            registry
                .register(
                    id,
                    flag.clone(),
                    plugin.map(|plugin| TransferOwner {
                        plugin_id: plugin.into(),
                        generation,
                        cancelled: sender,
                    }),
                )
                .unwrap();
            flags.push(flag);
        }
        registry.cancel_plugin_before("one", 8);
        assert_eq!(
            flags
                .iter()
                .map(|flag| flag.load(Ordering::SeqCst))
                .collect::<Vec<_>>(),
            [true, false, false, false, false]
        );
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
        registry.update(&mut transfer_event("owned", TransferStatus::Running));
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
    async fn plugin_transfers_drain_writers_on_cancel_revoke_restricted_mode_and_restart() {
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
            let (stopped_sender, stopped) = tokio::sync::oneshot::channel();
            let (drain, drained) = tokio::sync::oneshot::channel();
            let cancel = Arc::new(AtomicBool::new(false));
            let flag = cancel.clone();
            let operation_security = security.clone();
            let keep_open = sender.clone();
            let task = tokio::spawn(async move {
                let _keep_open = keep_open;
                guard_plugin_transfer(&operation_security, &owner, &mut cancelled, &flag, async {
                    let _marker = Dropped(marker);
                    let _ = ready.send(());
                    while !flag.load(Ordering::SeqCst) {
                        tokio::task::yield_now().await;
                    }
                    let _ = stopped_sender.send(());
                    // Represent already-issued writes and CLOSE awaiting ACK.
                    drained.await.unwrap();
                    Outcome::Cancelled(42)
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
            tokio::time::timeout(std::time::Duration::from_secs(1), stopped)
                .await
                .unwrap()
                .unwrap();
            assert!(cancel.load(Ordering::SeqCst), "{action}");
            assert!(
                !dropped.load(Ordering::SeqCst),
                "writer dropped before CLOSE for {action}"
            );
            assert!(
                !task.is_finished(),
                "cleanup could run before IO drained for {action}"
            );
            drain.send(()).unwrap();
            let result = tokio::time::timeout(std::time::Duration::from_secs(1), task)
                .await
                .unwrap()
                .unwrap();
            assert!(matches!(result, Outcome::Cancelled(42)), "{action}");
            assert!(
                dropped.load(Ordering::SeqCst),
                "in-flight transfer survived {action}"
            );
        }
    }

    #[tokio::test]
    async fn plugin_transfer_guard_handles_prestart_revocation_and_completed_writers() {
        use crate::plugins::security::PluginSecurity;
        for action in [
            "already-cancelled",
            "already-revoked",
            "complete-and-revoke",
            "complete",
        ] {
            let db = crate::db::Database::in_memory().unwrap();
            let security = PluginSecurity::default();
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
            let (_sender, mut cancelled) =
                tokio::sync::watch::channel(action == "already-cancelled");
            let cancel = AtomicBool::new(false);
            let mutated = AtomicBool::new(false);
            if action == "already-revoked" {
                security.invalidate_runtime("plugin");
            }
            let result = guard_plugin_transfer(&security, &owner, &mut cancelled, &cancel, async {
                let result = interruptible(Some(&cancel), async {
                    mutated.store(true, Ordering::SeqCst);
                    if action == "complete-and-revoke" {
                        security.invalidate_runtime("plugin");
                    }
                    Ok(())
                })
                .await;
                Outcome::from_result(result, 42, &cancel)
            })
            .await;
            if action.starts_with("already") {
                assert!(cancel.load(Ordering::SeqCst));
                assert!(!mutated.load(Ordering::SeqCst), "{action}");
                assert!(matches!(result, Outcome::Cancelled(_)), "{action}");
            } else {
                // A committed result remains committed; do not re-poll the
                // completed operation or claim its destination was cancelled.
                assert!(mutated.load(Ordering::SeqCst));
                assert!(matches!(result, Outcome::Done(42)), "{action}");
            }
        }
    }

    #[tokio::test]
    async fn local_transfer_commit_preserves_a_destination_created_after_backup() {
        let root = temp_root("transfer-commit-conflict");
        let target = Endpoint {
            session: None,
            path: display_path(&root.join("target")),
        };
        let temp = staging_endpoint(&target, "job", "part");
        let backup = staging_endpoint(&target, "job", "backup");
        std::fs::write(&target.path, b"old destination").unwrap();
        std::fs::write(&temp.path, b"incoming").unwrap();
        rename_endpoint(&target, &backup, None).await.unwrap();
        std::fs::write(&target.path, b"independent destination").unwrap();
        assert_eq!(
            rename_endpoint(&temp, &target, None)
                .await
                .unwrap_err()
                .to_string(),
            "sftp.alreadyExists"
        );
        assert_eq!(
            std::fs::read(&target.path).unwrap(),
            b"independent destination"
        );
        assert_eq!(std::fs::read(&backup.path).unwrap(), b"old destination");
        assert_eq!(std::fs::read(&temp.path).unwrap(), b"incoming");
        // A concurrently created backup must not be replaced either.
        assert!(rename_endpoint(&target, &backup, None).await.is_err());
        assert_eq!(
            std::fs::read(&target.path).unwrap(),
            b"independent destination"
        );
        assert_eq!(std::fs::read(&backup.path).unwrap(), b"old destination");
        std::fs::remove_dir_all(root).unwrap();
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
            Outcome::Failed(512, error) => assert_eq!(error.to_string(), "permission denied"),
            _ => panic!("non-cancellation failure must preserve its error and progress"),
        }
        let outcome = Outcome::from_result(
            Err(AppError::BackupRecovery {
                backup: "/backup".into(),
                destination: "/target".into(),
            }),
            512,
            &cancel,
        );
        assert!(matches!(outcome,
            Outcome::Failed(512, AppError::BackupRecovery { backup, destination })
                if backup == "/backup" && destination == "/target"
        ));
    }

    mod protocol_io {
        use super::*;
        use russh_sftp::protocol::{Attrs, Data, FileAttributes, Handle, Status};
        use std::collections::HashMap;
        use std::io::{Read, Seek, SeekFrom, Write};
        use std::sync::atomic::AtomicUsize;
        use tokio::sync::Notify;

        type RecordedRequests = Arc<std::sync::Mutex<Vec<(String, Vec<u8>)>>>;

        struct RenameServer {
            advertised: Option<&'static str>,
            received: RecordedRequests,
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
                if let Some(advertised) = self.advertised {
                    version
                        .extensions
                        .insert("posix-rename@openssh.com".into(), advertised.into());
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
                    advertised: Some("1"),
                    received: received.clone(),
                    result: StatusCode::Ok,
                },
            )
            .await;
            let raw = russh_sftp::client::RawSftpSession::new(client);
            let replacement = remote_commit::Replacement::negotiate(raw).await.unwrap();
            assert!(
                received.lock().unwrap().is_empty(),
                "negotiation must not mutate files"
            );
            replacement.commit("/源 ' a", "/new\nname").await.unwrap();
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
                (None, StatusCode::Ok, 0),
                (Some("0"), StatusCode::Ok, 0),
                (Some("2"), StatusCode::Ok, 0),
                (Some("1"), StatusCode::PermissionDenied, 1),
                (Some("1"), StatusCode::Failure, 1),
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
                let error = async {
                    remote_commit::Replacement::negotiate(raw)
                        .await?
                        .commit("/a", "/b")
                        .await
                }
                .await
                .unwrap_err();
                if advertised != Some("1") {
                    assert_eq!(error.to_string(), "sftp.overwriteUnsupported");
                }
                assert_eq!(received.lock().unwrap().len(), expected_requests);
            }
        }

        #[derive(Default)]
        struct State {
            closes: AtomicUsize,
            hold_open: AtomicBool,
            open_started: Notify,
            release_open: Notify,
            hold_metadata: AtomicBool,
            fail_metadata: AtomicBool,
            metadata_started: Notify,
            release_metadata: Notify,
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
            replace_before_remove: AtomicBool,
            metadata_reads: AtomicUsize,
            directories_created: AtomicUsize,
            hold_mkdir: AtomicBool,
            mkdir_started: Notify,
            release_mkdir: Notify,
            removals: AtomicUsize,
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
                self.state.open_started.notify_one();
                if self.state.hold_open.load(Ordering::SeqCst) {
                    self.state.release_open.notified().await;
                }
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
                self.state.metadata_reads.fetch_add(1, Ordering::SeqCst);
                self.state.metadata_started.notify_one();
                if self.state.hold_metadata.load(Ordering::SeqCst) {
                    self.state.release_metadata.notified().await;
                }
                if self.state.fail_metadata.load(Ordering::SeqCst) {
                    return Err(StatusCode::PermissionDenied);
                }
                let metadata =
                    std::fs::symlink_metadata(self.root.join(path)).map_err(io_status)?;
                let mut attrs = FileAttributes::from(&metadata);
                if local_metadata_is_link(&metadata) {
                    attrs.set_type(russh_sftp::protocol::FileMode::LNK);
                }
                Ok(Attrs { id, attrs })
            }

            async fn mkdir(
                &mut self,
                id: u32,
                path: String,
                _attrs: FileAttributes,
            ) -> Result<Status, StatusCode> {
                self.state
                    .directories_created
                    .fetch_add(1, Ordering::SeqCst);
                std::fs::create_dir(self.root.join(path)).map_err(io_status)?;
                self.state.mkdir_started.notify_one();
                if self.state.hold_mkdir.load(Ordering::SeqCst) {
                    self.state.release_mkdir.notified().await;
                }
                Ok(status(id))
            }

            async fn remove(&mut self, id: u32, filename: String) -> Result<Status, StatusCode> {
                self.state.removals.fetch_add(1, Ordering::SeqCst);
                let path = self.root.join(filename);
                if self.state.replace_before_remove.load(Ordering::SeqCst) {
                    std::fs::remove_file(&path).map_err(io_status)?;
                    std::fs::write(&path, b"independent replacement").map_err(io_status)?;
                }
                std::fs::remove_file(path).map_err(io_status)?;
                Ok(status(id))
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
                files.finish(false).await.unwrap();
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
                let files = range_io::Files::open(&sessions, &source, &target)
                    .await
                    .unwrap()
                    .with_throttle(bandwidth::Throttle {
                        controller: controller.clone(),
                        id: "test".into(),
                    });
                let start = std::time::Instant::now();
                // Measure from a fresh budget. Opening SFTP handles may take
                // long enough to earn the intentional 100ms of idle credit.
                controller.configure(256, 256);
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
                files.finish(false).await.unwrap();
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
            assert!(files.finish(false).await.is_err());
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
            files.finish(false).await.unwrap();
            drop(sessions);
            std::fs::remove_dir_all(root).unwrap();
        }

        #[tokio::test]
        async fn verification_cancellation_does_not_wait_for_readonly_open_read_or_close() {
            for stage in ["open", "read", "close"] {
                let root = temp_root("verify-cancel");
                let content = vec![29; CHUNK + 17];
                std::fs::write(root.join("source"), &content).unwrap();
                std::fs::write(root.join("partial"), &content).unwrap();
                let state = Arc::new(State::default());
                let sftp = client(&root, state.clone()).await;
                let source = Endpoint {
                    session: None,
                    path: display_path(&root.join("source")),
                };
                let partial = Endpoint {
                    session: Some("test".into()),
                    path: "partial".into(),
                };
                let mut reader = open_reader(&source, None).await.unwrap();
                let (hold, started, release) = match stage {
                    "open" => (&state.hold_open, &state.open_started, &state.release_open),
                    "read" => (&state.hold_read, &state.read_started, &state.release_read),
                    _ => (
                        &state.delay_close,
                        &state.close_started,
                        &state.release_close,
                    ),
                };
                hold.store(true, Ordering::SeqCst);
                let cancel = AtomicBool::new(false);
                let result = tokio::time::timeout(std::time::Duration::from_millis(500), async {
                    tokio::join!(
                        verify_prefix(
                            &mut reader,
                            &partial,
                            Some(&sftp),
                            content.len() as u64,
                            Some(&cancel)
                        ),
                        async {
                            started.notified().await;
                            cancel.store(true, Ordering::SeqCst);
                        }
                    )
                    .0
                })
                .await;
                hold.store(false, Ordering::SeqCst);
                release.notify_one();
                reader.finish().await.unwrap();
                // A late read/CLOSE reply must not kill this shared metadata channel.
                tokio::time::timeout(std::time::Duration::from_secs(2), sftp.metadata("partial"))
                    .await
                    .unwrap()
                    .unwrap();
                sftp.close().await.unwrap();
                assert_eq!(std::fs::read(root.join("source")).unwrap(), content);
                assert_eq!(std::fs::read(root.join("partial")).unwrap(), content);
                std::fs::remove_dir_all(root).unwrap();
                assert_eq!(result.expect(stage).unwrap_err().to_string(), CANCELLED);
            }
        }

        #[tokio::test]
        async fn fingerprint_cancellation_does_not_wait_for_metadata_read_or_close() {
            for stage in ["metadata", "read", "close"] {
                let root = temp_root("fingerprint-cancel");
                let content = vec![31; CHUNK + 19];
                std::fs::write(root.join("backup"), &content).unwrap();
                let state = Arc::new(State::default());
                let sftp = client(&root, state.clone()).await;
                let backup = Endpoint {
                    session: Some("test".into()),
                    path: "backup".into(),
                };
                let (hold, started, release) = match stage {
                    "metadata" => (
                        &state.hold_metadata,
                        &state.metadata_started,
                        &state.release_metadata,
                    ),
                    "read" => (&state.hold_read, &state.read_started, &state.release_read),
                    _ => (
                        &state.delay_close,
                        &state.close_started,
                        &state.release_close,
                    ),
                };
                hold.store(true, Ordering::SeqCst);
                let cancel = AtomicBool::new(false);
                let result = tokio::time::timeout(std::time::Duration::from_millis(500), async {
                    tokio::join!(fingerprint_file(&backup, Some(&sftp), &cancel), async {
                        started.notified().await;
                        cancel.store(true, Ordering::SeqCst);
                    })
                    .0
                })
                .await;
                hold.store(false, Ordering::SeqCst);
                release.notify_one();
                tokio::time::timeout(std::time::Duration::from_secs(2), sftp.metadata("backup"))
                    .await
                    .unwrap()
                    .unwrap();
                sftp.close().await.unwrap();
                assert_eq!(std::fs::read(root.join("backup")).unwrap(), content);
                assert_eq!(state.removals.load(Ordering::SeqCst), 0);
                std::fs::remove_dir_all(root).unwrap();
                assert_eq!(result.expect(stage).unwrap_err().to_string(), CANCELLED);
            }
        }

        #[tokio::test]
        async fn cancelling_read_close_preserves_shared_channel_and_writer_acknowledgements() {
            let root = temp_root("read-close-cancel");
            std::fs::write(root.join("source"), b"keep source").unwrap();
            let state = Arc::new(State::default());
            let sftp = client(&root, state.clone()).await;
            let source = Endpoint {
                session: Some("test".into()),
                path: "source".into(),
            };
            let reader = open_reader(&source, Some(&sftp)).await.unwrap();
            state.delay_close.store(true, Ordering::SeqCst);
            let cancel = AtomicBool::new(false);
            let (result, ()) = tokio::time::timeout(std::time::Duration::from_millis(500), async {
                tokio::join!(reader.finish_cancellable(&cancel), async {
                    state.close_started.notified().await;
                    cancel.store(true, Ordering::SeqCst);
                })
            })
            .await
            .unwrap();
            assert_eq!(result.unwrap_err().to_string(), CANCELLED);
            state.delay_close.store(false, Ordering::SeqCst);
            state.release_close.notify_one();
            // No channel abort: the late CLOSE is followed by an acknowledged write.
            let target = Endpoint {
                session: Some("test".into()),
                path: "writer".into(),
            };
            let mut writer = open_writer(&target, Some(&sftp), false).await.unwrap();
            writer.write_all(b"confirmed write").await.unwrap();
            state.delay_close.store(true, Ordering::SeqCst);
            let finish = writer.finish();
            tokio::pin!(finish);
            tokio::select! {
                value = &mut finish => panic!("Writer must wait for CLOSE: {value:?}"),
                _ = state.close_started.notified() => {}
            }
            // Even an already-set cancellation flag must not abandon a writer.
            assert!(cancel.load(Ordering::SeqCst));
            assert!(
                tokio::time::timeout(std::time::Duration::from_millis(60), &mut finish)
                    .await
                    .is_err()
            );
            state.delay_close.store(false, Ordering::SeqCst);
            state.release_close.notify_one();
            finish.await.unwrap();
            assert_eq!(state.closes.load(Ordering::SeqCst), 2);
            assert_eq!(std::fs::read(root.join("source")).unwrap(), b"keep source");
            assert_eq!(
                std::fs::read(root.join("writer")).unwrap(),
                b"confirmed write"
            );
            sftp.close().await.unwrap();
            std::fs::remove_dir_all(root).unwrap();
        }

        #[tokio::test]
        async fn readonly_verification_keeps_close_errors_without_cancellation() {
            let root = temp_root("verify-close-error");
            let content = b"verified contents";
            std::fs::write(root.join("source"), content).unwrap();
            std::fs::write(root.join("target"), content).unwrap();
            let state = Arc::new(State::default());
            let sftp = client(&root, state.clone()).await;
            let source = Endpoint {
                session: None,
                path: display_path(&root.join("source")),
            };
            let target = Endpoint {
                session: Some("test".into()),
                path: "target".into(),
            };
            let cancel = AtomicBool::new(false);
            state.fail_close.store(true, Ordering::SeqCst);
            let mut reader = open_reader(&source, None).await.unwrap();
            assert!(verify_prefix(
                &mut reader,
                &target,
                Some(&sftp),
                content.len() as u64,
                Some(&cancel)
            )
            .await
            .is_err());
            reader.finish().await.unwrap();
            assert!(fingerprint_file(&target, Some(&sftp), &cancel)
                .await
                .is_err());
            state.fail_close.store(false, Ordering::SeqCst);
            assert!(fingerprint_file(&target, Some(&sftp), &cancel)
                .await
                .is_ok());
            assert_eq!(std::fs::read(root.join("source")).unwrap(), content);
            assert_eq!(std::fs::read(root.join("target")).unwrap(), content);
            assert_eq!(state.removals.load(Ordering::SeqCst), 0);
            sftp.close().await.unwrap();
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
        async fn cleanup_keeps_remote_backup_when_destination_is_recreated() {
            let root = temp_root("cleanup-recreated-target");
            let target = Endpoint {
                session: Some("test".into()),
                path: "target".into(),
            };
            let backup = staging_endpoint(&target, "job", "backup");
            std::fs::write(root.join(&backup.path), b"old destination").unwrap();
            std::fs::write(root.join(&target.path), b"new independent destination").unwrap();
            let sftp = client(&root, Arc::new(State::default())).await;
            let expected = fingerprint_file(&backup, Some(&sftp), &AtomicBool::new(false))
                .await
                .unwrap();
            std::fs::remove_file(root.join(&target.path)).unwrap();
            assert_eq!(
                artifacts::cleanup_owned("job", &target, Some(&sftp), Some(&expected), None)
                    .await
                    .unwrap_err()
                    .to_string(),
                "sftp.backupRecoveryRequired"
            );
            assert!(!root.join(&target.path).exists());
            assert_eq!(
                std::fs::read(root.join(&backup.path)).unwrap(),
                b"old destination"
            );
            std::fs::write(root.join(&target.path), b"new independent destination").unwrap();
            assert_eq!(
                artifacts::cleanup_owned("job", &target, Some(&sftp), Some(&expected), None)
                    .await
                    .unwrap_err()
                    .to_string(),
                "sftp.backupRecoveryRequired"
            );
            assert_eq!(
                std::fs::read(root.join(&backup.path)).unwrap(),
                b"old destination"
            );
            assert_eq!(
                std::fs::read(root.join(&target.path)).unwrap(),
                b"new independent destination"
            );
            sftp.close().await.unwrap();
            std::fs::remove_file(root.join(backup.path)).unwrap();
            std::fs::remove_file(root.join(target.path)).unwrap();
            std::fs::remove_dir(root).unwrap();
        }

        #[tokio::test]
        async fn transfer_artifact_removal_uses_only_sftp_file_unlink() {
            let root = temp_root("artifact-directory");
            let state = Arc::new(State::default());
            let sftp = client(&root, state.clone()).await;
            let artifact = Endpoint {
                session: Some("test".into()),
                path: "artifact".into(),
            };
            std::fs::create_dir(root.join(&artifact.path)).unwrap();
            let independent = root.join("artifact/independent.txt");
            std::fs::write(&independent, b"preserve directory content").unwrap();
            assert!(remove_transfer_file(&artifact, Some(&sftp)).await.is_err());
            assert_eq!(state.removals.load(Ordering::SeqCst), 1);
            assert_eq!(state.metadata_reads.load(Ordering::SeqCst), 0);
            assert_eq!(
                std::fs::read(&independent).unwrap(),
                b"preserve directory content"
            );
            std::fs::remove_file(&independent).unwrap();
            std::fs::remove_dir(root.join(&artifact.path)).unwrap();
            std::fs::write(root.join(&artifact.path), b"partial file").unwrap();
            remove_transfer_file(&artifact, Some(&sftp)).await.unwrap();
            assert_eq!(state.removals.load(Ordering::SeqCst), 2);
            assert_eq!(state.metadata_reads.load(Ordering::SeqCst), 0);
            assert!(!root.join(&artifact.path).exists());
            sftp.close().await.unwrap();
            std::fs::remove_dir(root).unwrap();
        }

        #[tokio::test]
        async fn backup_cleanup_preserves_original_and_replacements_without_path_unlink() {
            let root = temp_root("backup-remove-race");
            let backup = Endpoint {
                session: Some("test".into()),
                path: "backup".into(),
            };
            std::fs::write(root.join(&backup.path), b"original backup").unwrap();
            let state = Arc::new(State::default());
            let sftp = client(&root, state.clone()).await;
            let cancel = AtomicBool::new(false);
            let expected = fingerprint_file(&backup, Some(&sftp), &cancel)
                .await
                .unwrap();
            state.replace_before_remove.store(true, Ordering::SeqCst);
            assert!(
                !remove_verified_backup(&backup, Some(&sftp), &expected, &cancel)
                    .await
                    .unwrap()
            );
            assert_eq!(state.removals.load(Ordering::SeqCst), 0);
            assert_eq!(
                std::fs::read(root.join(&backup.path)).unwrap(),
                b"original backup"
            );
            // A replacement can have exactly the recorded bytes and timestamp.
            // Even a successful fingerprint check must not authorize unlink.
            let modified = std::fs::metadata(root.join(&backup.path))
                .unwrap()
                .modified()
                .unwrap();
            std::fs::remove_file(root.join(&backup.path)).unwrap();
            std::fs::write(root.join(&backup.path), b"original backup").unwrap();
            std::fs::File::options()
                .write(true)
                .open(root.join(&backup.path))
                .unwrap()
                .set_times(std::fs::FileTimes::new().set_modified(modified))
                .unwrap();
            assert!(
                !remove_verified_backup(&backup, Some(&sftp), &expected, &cancel)
                    .await
                    .unwrap()
            );
            assert_eq!(state.removals.load(Ordering::SeqCst), 0);
            std::fs::write(root.join(&backup.path), b"independent replacement").unwrap();
            assert!(
                remove_verified_backup(&backup, Some(&sftp), &expected, &cancel)
                    .await
                    .is_err()
            );
            sftp.close().await.unwrap();
            let remaining = std::fs::read(root.join(&backup.path));
            std::fs::remove_dir_all(root).unwrap();
            assert_eq!(remaining.unwrap(), b"independent replacement");
        }

        #[tokio::test]
        async fn move_verification_preserves_sftp_sources_after_copy_and_concurrent_changes() {
            let root = temp_root("sftp-move-retained");
            let state = Arc::new(State::default());
            state.replace_before_remove.store(true, Ordering::SeqCst);
            let sftp = client(&root, state.clone()).await;
            let cancel = AtomicBool::new(false);
            for (remote_from, remote_to) in [(true, false), (false, true), (true, true)] {
                let source = Endpoint {
                    session: remote_from.then(|| "test".into()),
                    path: if remote_from {
                        "source".into()
                    } else {
                        display_path(&root.join("source"))
                    },
                };
                let target = Endpoint {
                    session: remote_to.then(|| "test".into()),
                    path: if remote_to {
                        "target".into()
                    } else {
                        display_path(&root.join("target"))
                    },
                };
                std::fs::write(root.join("source"), b"complete copy").unwrap();
                std::fs::write(root.join("target"), b"complete copy").unwrap();
                move_verification::verify(
                    &source,
                    &target,
                    remote_from.then_some(sftp.as_ref()),
                    remote_to.then_some(sftp.as_ref()),
                    &cancel,
                )
                .await
                .unwrap();
                std::fs::rename(root.join("source"), root.join("old-source")).unwrap();
                std::fs::write(root.join("source"), b"replacement source").unwrap();
                std::fs::write(root.join("target"), b"changed target").unwrap();
                assert_eq!(
                    move_verification::require_guarded_deletion(false, &cancel)
                        .unwrap_err()
                        .to_string(),
                    "sftp.moveSourceRetained"
                );
                assert_eq!(
                    std::fs::read(root.join("source")).unwrap(),
                    b"replacement source"
                );
                assert_eq!(
                    std::fs::read(root.join("old-source")).unwrap(),
                    b"complete copy"
                );
                assert_eq!(
                    std::fs::read(root.join("target")).unwrap(),
                    b"changed target"
                );
                assert_eq!(state.removals.load(Ordering::SeqCst), 0);
                std::fs::remove_file(root.join("old-source")).unwrap();
            }
            sftp.close().await.unwrap();
            std::fs::remove_dir_all(root).unwrap();
        }

        #[tokio::test]
        async fn move_verification_checks_complete_sftp_contents_in_both_directions() {
            let root = temp_root("sftp-move-content");
            let state = Arc::new(State::default());
            // Exercise short reads as well as multiple comparison buffers.
            state.max_read.store(1021, Ordering::SeqCst);
            let sftp = client(&root, state.clone()).await;
            let content = vec![17; CHUNK * 3 + 19];
            let cancel = AtomicBool::new(false);
            for (from_remote, to_remote) in [(true, false), (false, true), (true, true)] {
                let source = Endpoint {
                    session: from_remote.then(|| "test".into()),
                    path: if from_remote {
                        "source".into()
                    } else {
                        display_path(&root.join("source"))
                    },
                };
                let target = Endpoint {
                    session: to_remote.then(|| "test".into()),
                    path: if to_remote {
                        "target".into()
                    } else {
                        display_path(&root.join("target"))
                    },
                };
                std::fs::write(root.join("source"), &content).unwrap();
                let from_sftp = from_remote.then_some(sftp.as_ref());
                let to_sftp = to_remote.then_some(sftp.as_ref());
                for changed in [
                    b"short".to_vec(),
                    {
                        let mut changed = content.clone();
                        changed[CHUNK * 2 + 7] ^= 1;
                        changed
                    },
                    content.clone(),
                ] {
                    std::fs::write(root.join("target"), &content).unwrap();
                    let original_modified = std::fs::metadata(root.join("target"))
                        .unwrap()
                        .modified()
                        .unwrap();
                    std::fs::write(root.join("target"), &changed).unwrap();
                    std::fs::File::options()
                        .write(true)
                        .open(root.join("target"))
                        .unwrap()
                        .set_times(std::fs::FileTimes::new().set_modified(original_modified))
                        .unwrap();
                    let result =
                        move_verification::verify(&source, &target, from_sftp, to_sftp, &cancel)
                            .await;
                    if changed == content {
                        result.unwrap();
                    } else {
                        assert_eq!(
                            result.unwrap_err().to_string(),
                            "sftp.moveVerificationFailed"
                        );
                    }
                    assert_eq!(std::fs::read(root.join("source")).unwrap(), content);
                    assert_eq!(std::fs::read(root.join("target")).unwrap(), changed);
                }
                std::fs::write(root.join("source"), b"").unwrap();
                std::fs::write(root.join("target"), b"").unwrap();
                move_verification::verify(&source, &target, from_sftp, to_sftp, &cancel)
                    .await
                    .unwrap();
            }
            assert_eq!(state.removals.load(Ordering::SeqCst), 0);
            sftp.close().await.unwrap();
            std::fs::remove_dir_all(root).unwrap();
        }

        #[tokio::test]
        async fn move_verification_cancels_stalled_sftp_reads_and_preserves_close_errors() {
            let root = temp_root("sftp-move-cancel");
            let state = Arc::new(State::default());
            let sftp = client(&root, state.clone()).await;
            let source = Endpoint {
                session: Some("test".into()),
                path: "source".into(),
            };
            let target = Endpoint {
                session: None,
                path: display_path(&root.join("target")),
            };
            std::fs::write(root.join("source"), b"keep both files").unwrap();
            std::fs::write(&target.path, b"keep both files").unwrap();
            let cancel = AtomicBool::new(false);
            state.hold_read.store(true, Ordering::SeqCst);
            let (result, ()) = tokio::time::timeout(std::time::Duration::from_millis(500), async {
                tokio::join!(
                    move_verification::verify(&source, &target, Some(&sftp), None, &cancel),
                    async {
                        state.read_started.notified().await;
                        cancel.store(true, Ordering::SeqCst);
                    }
                )
            })
            .await
            .unwrap();
            assert_eq!(result.unwrap_err().to_string(), CANCELLED);
            state.hold_read.store(false, Ordering::SeqCst);
            state.release_read.notify_one();
            cancel.store(false, Ordering::SeqCst);
            state.fail_close.store(true, Ordering::SeqCst);
            assert!(
                move_verification::verify(&source, &target, Some(&sftp), None, &cancel)
                    .await
                    .is_err()
            );
            assert_eq!(
                std::fs::read(root.join("source")).unwrap(),
                b"keep both files"
            );
            assert_eq!(std::fs::read(&target.path).unwrap(), b"keep both files");
            assert_eq!(state.removals.load(Ordering::SeqCst), 0);
            sftp.close().await.unwrap();
            std::fs::remove_dir_all(root).unwrap();
        }

        #[tokio::test]
        async fn move_verification_rejects_destination_changed_during_remote_read() {
            let root = temp_root("sftp-move-concurrent-change");
            let state = Arc::new(State::default());
            let sftp = client(&root, state.clone()).await;
            let source = Endpoint {
                session: Some("test".into()),
                path: "source".into(),
            };
            let target = Endpoint {
                session: None,
                path: display_path(&root.join("target")),
            };
            let content = vec![17; CHUNK * 3 + 19];
            std::fs::write(root.join("source"), &content).unwrap();
            std::fs::write(&target.path, &content).unwrap();
            let cancel = AtomicBool::new(false);
            state.hold_read.store(true, Ordering::SeqCst);
            let (result, ()) = tokio::join!(
                move_verification::verify(&source, &target, Some(&sftp), None, &cancel),
                async {
                    state.read_started.notified().await;
                    let mut changed = content.clone();
                    changed[CHUNK * 2 + 7] ^= 1;
                    std::fs::write(&target.path, changed).unwrap();
                    state.hold_read.store(false, Ordering::SeqCst);
                    state.release_read.notify_one();
                }
            );
            assert_eq!(
                result.unwrap_err().to_string(),
                "sftp.moveVerificationFailed"
            );
            assert_eq!(std::fs::read(root.join("source")).unwrap(), content);
            assert_eq!(state.removals.load(Ordering::SeqCst), 0);
            sftp.close().await.unwrap();
            std::fs::remove_dir_all(root).unwrap();
        }

        #[tokio::test]
        async fn interrupted_move_preserves_remote_source_entries_and_destinations() {
            let root = temp_root("sftp-interrupted-move");
            let state = Arc::new(State::default());
            let sftp = client(&root, state.clone()).await;
            let source = Endpoint {
                session: Some("test".into()),
                path: "source".into(),
            };
            for target_contents in [b"original".as_slice(), b"modified", b""] {
                std::fs::write(root.join("target"), target_contents).unwrap();
                assert_eq!(
                    interrupted_move_error(&source, Some(&sftp))
                        .await
                        .to_string(),
                    "sftp.moveRecoveryUnverified"
                );
                std::fs::write(root.join("source"), b"original").unwrap();
                assert_eq!(
                    interrupted_move_error(&source, Some(&sftp))
                        .await
                        .to_string(),
                    "sftp.moveRecoverySourcePresent"
                );
                assert_eq!(std::fs::read(root.join("source")).unwrap(), b"original");
                assert_eq!(std::fs::read(root.join("target")).unwrap(), target_contents);
                std::fs::remove_file(root.join("source")).unwrap();
            }
            std::fs::create_dir(root.join("source")).unwrap();
            assert_eq!(
                interrupted_move_error(&source, Some(&sftp))
                    .await
                    .to_string(),
                "sftp.moveRecoverySourcePresent"
            );
            assert_eq!(state.removals.load(Ordering::SeqCst), 0);
            assert_eq!(state.read_bytes.load(Ordering::SeqCst), 0);
            sftp.close().await.unwrap();
            // An unavailable server must not be mistaken for a missing source.
            assert_ne!(
                interrupted_move_error(&source, Some(&sftp))
                    .await
                    .to_string(),
                "sftp.moveRecoveryUnverified"
            );
            std::fs::remove_file(root.join("target")).unwrap();
            std::fs::remove_dir(root.join("source")).unwrap();
            std::fs::remove_dir(root).unwrap();
        }

        #[tokio::test]
        async fn transfer_move_rejects_remote_directories_without_removing_source() {
            let root = temp_root("sftp-move-guard");
            std::fs::create_dir(root.join("folder")).unwrap();
            std::fs::write(root.join("folder/file.txt"), b"preserved").unwrap();
            let sftp = client(&root, Arc::new(State::default())).await;
            let directory = Endpoint {
                session: Some("test".into()),
                path: "folder".into(),
            };
            let file = Endpoint {
                session: Some("test".into()),
                path: "folder/file.txt".into(),
            };
            assert_eq!(
                ensure_safe_transfer_move_source(&directory, Some(&sftp))
                    .await
                    .unwrap_err()
                    .to_string(),
                "sftp.directoryMoveUnavailable"
            );
            assert!(ensure_safe_transfer_move_source(&file, Some(&sftp))
                .await
                .is_ok());
            assert_eq!(
                std::fs::read(root.join("folder/file.txt")).unwrap(),
                b"preserved"
            );
            sftp.close().await.unwrap();
            std::fs::remove_file(root.join("folder/file.txt")).unwrap();
            std::fs::remove_dir(root.join("folder")).unwrap();
            std::fs::remove_dir(root).unwrap();
        }

        #[tokio::test]
        async fn directory_preparation_cancelled_metadata_never_sends_a_late_mkdir() {
            let root = temp_root("directory-cancel-metadata");
            let state = Arc::new(State::default());
            state.hold_metadata.store(true, Ordering::SeqCst);
            let sftp = client(&root, state.clone()).await;
            let endpoint = Endpoint {
                session: Some("test".into()),
                path: "never-created".into(),
            };
            let cancel = AtomicBool::new(false);
            let (result, ()) = tokio::time::timeout(std::time::Duration::from_millis(500), async {
                tokio::join!(make_dir(&endpoint, Some(&sftp), Some(&cancel)), async {
                    state.metadata_started.notified().await;
                    cancel.store(true, Ordering::SeqCst);
                })
            })
            .await
            .expect("pause waited for directory metadata reply");
            assert_eq!(result.unwrap_err().to_string(), CANCELLED);
            state.hold_metadata.store(false, Ordering::SeqCst);
            state.release_metadata.notify_one();
            // Wait behind the old reply on the same protocol channel. It must
            // remain useful and the abandoned metadata cannot continue MKDIR.
            assert!(sftp.symlink_metadata(&endpoint.path).await.is_err());
            assert_eq!(state.directories_created.load(Ordering::SeqCst), 0);
            assert!(!root.join(&endpoint.path).exists());
            sftp.close().await.unwrap();
            std::fs::remove_dir(root).unwrap();
        }

        #[tokio::test]
        async fn directory_preparation_cancelled_before_poll_sends_no_requests() {
            let root = temp_root("directory-already-cancelled");
            let state = Arc::new(State::default());
            let sftp = client(&root, state.clone()).await;
            let endpoint = Endpoint {
                session: Some("test".into()),
                path: "never-created".into(),
            };
            let result = make_dir(&endpoint, Some(&sftp), Some(&AtomicBool::new(true))).await;
            assert_eq!(result.unwrap_err().to_string(), CANCELLED);
            assert_eq!(state.metadata_reads.load(Ordering::SeqCst), 0);
            assert_eq!(state.directories_created.load(Ordering::SeqCst), 0);
            assert!(!root.join(&endpoint.path).exists());
            sftp.close().await.unwrap();
            std::fs::remove_dir(root).unwrap();
        }

        #[tokio::test]
        async fn directory_preparation_keeps_the_acknowledgement_of_an_already_sent_mkdir() {
            let root = temp_root("directory-mkdir-drain");
            let state = Arc::new(State::default());
            state.hold_mkdir.store(true, Ordering::SeqCst);
            let sftp = client(&root, state.clone()).await;
            let endpoint = Endpoint {
                session: Some("test".into()),
                path: "acknowledged".into(),
            };
            let cancel = AtomicBool::new(false);
            let operation = make_dir(&endpoint, Some(&sftp), Some(&cancel));
            tokio::pin!(operation);
            tokio::select! {
                result = &mut operation => panic!("MKDIR was not awaited: {result:?}"),
                () = state.mkdir_started.notified() => {}
            }
            cancel.store(true, Ordering::SeqCst);
            assert!(
                tokio::time::timeout(std::time::Duration::from_millis(100), &mut operation)
                    .await
                    .is_err()
            );
            state.release_mkdir.notify_one();
            // The completed mutation is settled, then the caller observes its
            // cancellation before starting traversal or another child write.
            assert_eq!(operation.await.unwrap_err().to_string(), CANCELLED);
            assert_eq!(state.directories_created.load(Ordering::SeqCst), 1);
            assert!(root.join(&endpoint.path).is_dir());
            sftp.close().await.unwrap();
            std::fs::remove_dir(root.join(&endpoint.path)).unwrap();
            std::fs::remove_dir(root).unwrap();
        }

        #[tokio::test]
        async fn directory_preparation_uses_one_lstat_without_following_links_or_truncating_files()
        {
            let root = temp_root("sftp-directory-metadata");
            std::fs::create_dir(root.join("existing")).unwrap();
            std::fs::write(root.join("file"), b"preserved").unwrap();
            directory_link(&root.join("existing"), &root.join("link"));
            let state = Arc::new(State::default());
            let sftp = client(&root, state.clone()).await;
            for (index, path) in ["existing", "created", "file", "link"]
                .into_iter()
                .enumerate()
            {
                let result = make_dir(
                    &Endpoint {
                        session: Some("test".into()),
                        path: path.into(),
                    },
                    Some(&sftp),
                    None,
                )
                .await;
                match path {
                    "existing" | "created" => result.unwrap(),
                    "file" => assert_eq!(result.unwrap_err().to_string(), "sftp.typeConflict"),
                    "link" => {
                        assert_eq!(result.unwrap_err().to_string(), "sftp.symlinkUnsupported")
                    }
                    _ => unreachable!(),
                }
                assert_eq!(state.metadata_reads.load(Ordering::SeqCst), index + 1);
            }
            assert_eq!(state.directories_created.load(Ordering::SeqCst), 1);
            state.fail_metadata.store(true, Ordering::SeqCst);
            assert!(make_dir(
                &Endpoint {
                    session: Some("test".into()),
                    path: "denied".into(),
                },
                Some(&sftp),
                None,
            )
            .await
            .is_err());
            assert_eq!(state.directories_created.load(Ordering::SeqCst), 1);
            assert!(!root.join("denied").exists());
            assert!(root.join("created").is_dir());
            assert_eq!(std::fs::read(root.join("file")).unwrap(), b"preserved");
            sftp.close().await.unwrap();
            #[cfg(windows)]
            std::fs::remove_dir(root.join("link")).unwrap();
            #[cfg(unix)]
            std::fs::remove_file(root.join("link")).unwrap();
            std::fs::remove_file(root.join("file")).unwrap();
            std::fs::remove_dir(root.join("existing")).unwrap();
            std::fs::remove_dir(root.join("created")).unwrap();
            std::fs::remove_dir(root).unwrap();
        }

        #[tokio::test]
        async fn transfer_preparation_rejects_remote_destination_links() {
            let root = temp_root("sftp-destination-link");
            let outside = root.join("outside");
            std::fs::create_dir(&outside).unwrap();
            std::fs::write(outside.join("preserved.txt"), "preserve").unwrap();
            std::fs::write(root.join("source.txt"), "overwrite").unwrap();
            let link = root.join("link");
            directory_link(&outside, &link);
            let sftp = client(&root, Arc::new(State::default())).await;
            let error = reject_remote_destination_link(&sftp, "link")
                .await
                .unwrap_err();
            assert!(error.to_string().contains("sftp.symlinkUnsupported"));
            let endpoint = Endpoint {
                session: Some("test".into()),
                path: "link".into(),
            };
            assert!(make_dir(&endpoint, Some(&sftp), None).await.is_err());
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
        async fn text_reads_wait_for_the_close_acknowledgement() {
            let root = temp_root("protocol-read-ack");
            std::fs::write(root.join("note.txt"), "original").unwrap();
            let state = Arc::new(State::default());
            state.delay_close.store(true, Ordering::SeqCst);
            let sftp = client(&root, state.clone()).await;
            let task_client = sftp.clone();
            let operation =
                tokio::spawn(async move { read_remote_text(&task_client, "note.txt").await });
            tokio::time::timeout(
                std::time::Duration::from_secs(5),
                state.close_started.notified(),
            )
            .await
            .expect("CLOSE request");
            assert!(
                !operation.is_finished(),
                "read returned before CLOSE acknowledgement"
            );
            state.release_close.notify_one();
            operation.await.unwrap().unwrap();
            assert_eq!(state.closes.load(Ordering::SeqCst), 1);
            sftp.close().await.unwrap();
            std::fs::remove_dir_all(root).unwrap();
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

    #[tokio::test]
    async fn directory_preparation_cancelled_local_does_not_create_parent_directories() {
        let root = temp_root("cancelled-local-directory");
        let endpoint = Endpoint {
            session: None,
            path: display_path(&root.join("parent/child")),
        };
        assert_eq!(
            make_dir(&endpoint, None, Some(&AtomicBool::new(true)))
                .await
                .unwrap_err()
                .to_string(),
            CANCELLED
        );
        assert!(!root.join("parent").exists());
        std::fs::remove_dir(root).unwrap();
    }

    #[tokio::test]
    async fn transfer_preparation_rejects_nested_destination_directory_links() {
        let root = temp_root("destination-link");
        let outside = root.join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("existing.txt"), "preserve").unwrap();
        let link = root.join("link");
        directory_link(&outside, &link);
        let endpoint = Endpoint {
            session: None,
            path: display_path(&link),
        };
        assert!(make_dir(&endpoint, None, None).await.is_err());
        assert!(open_writer(&endpoint, None, true).await.is_err());
        assert!(scan::measure(&endpoint, None, 1).await.is_err());
        assert_eq!(
            std::fs::read_to_string(outside.join("existing.txt")).unwrap(),
            "preserve"
        );
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
        assert!(make_dir(&endpoint, None, None).await.is_err());
        assert!(open_writer(&endpoint, None, true).await.is_err());
        #[cfg(windows)]
        std::fs::remove_dir(link).unwrap();
        #[cfg(unix)]
        std::fs::remove_file(link).unwrap();
        std::fs::remove_dir_all(root).unwrap();
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
    fn validates_overwrite_and_rejects_recursive_self_copy() {
        let root = temp_root("safe-copy");
        let source = root.join("source");
        let target = root.join("target");
        std::fs::create_dir_all(&source).unwrap();
        std::fs::write(source.join("a.txt"), "new").unwrap();
        std::fs::create_dir_all(&target).unwrap();
        std::fs::write(target.join("a.txt"), "old").unwrap();
        assert!(check_local_destination(&source, &target, false).is_err());
        assert_eq!(
            std::fs::read_to_string(target.join("a.txt")).unwrap(),
            "old"
        );
        assert!(check_local_destination(&source, &source.join("nested"), true).is_err());
        assert!(!source.join("nested").exists());
        check_local_destination(&source, &target, true).unwrap();
        assert_eq!(
            std::fs::read_to_string(target.join("a.txt")).unwrap(),
            "old"
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
