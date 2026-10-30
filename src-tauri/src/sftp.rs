// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use russh_sftp::client::SftpSession;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::error::{AppError, AppResult};
use crate::state::AppState;

pub const TRANSFER_EVENT: &str = "sftp://transfer";

const CHUNK: usize = 64 * 1024;
const PROGRESS_STEP: u64 = 256 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
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
    pub error: Option<String>,
}

#[derive(Default)]
pub struct TransferRegistry {
    active: std::sync::Mutex<std::collections::HashMap<String, Arc<AtomicBool>>>,
}

impl TransferRegistry {
    fn register(&self, id: &str, flag: Arc<AtomicBool>) {
        if let Ok(mut active) = self.active.lock() {
            active.insert(id.to_string(), flag);
        }
    }

    fn unregister(&self, id: &str) {
        if let Ok(mut active) = self.active.lock() {
            active.remove(id);
        }
    }

    pub fn cancel(&self, id: &str) {
        if let Ok(active) = self.active.lock() {
            if let Some(flag) = active.get(id) {
                flag.store(true, Ordering::SeqCst);
            }
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

fn map_sftp(error: russh_sftp::client::error::Error) -> AppError {
    AppError::Ssh(format!("sftp.error: {error}"))
}

fn display_path(path: &Path) -> String {
    let text = path.to_string_lossy().into_owned();
    text.strip_prefix(r"\\?\")
        .map(str::to_string)
        .unwrap_or(text)
}

pub fn home_dir() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .or_else(|| std::env::current_dir().ok())
        .unwrap_or_else(|| PathBuf::from("."))
}

async fn session(app: &AppHandle, session_id: &str) -> AppResult<SftpSession> {
    let handle = app.state::<AppState>().ssh.handle(session_id)?;
    let channel = handle
        .channel_open_session()
        .await
        .map_err(|error| AppError::Ssh(format!("sftp.channel: {error}")))?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|error| AppError::Ssh(format!("sftp.subsystem: {error}")))?;
    SftpSession::new(channel.into_stream())
        .await
        .map_err(map_sftp)
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
            FileEntry {
                name: entry.file_name(),
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
        entries.push(FileEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
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
) -> AppResult<()> {
    let sftp = session(app, session_id).await?;
    sftp.rename(from, to).await.map_err(map_sftp)?;
    let _ = sftp.close().await;
    Ok(())
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

pub fn local_rename(from: String, to: String) -> AppResult<()> {
    std::fs::rename(from, to)?;
    Ok(())
}

pub fn local_delete(path: String, _is_dir: bool) -> AppResult<()> {
    remove_local_entry(&PathBuf::from(path))
}

fn emit(app: &AppHandle, event: TransferEvent) {
    let _ = app.emit(TRANSFER_EVENT, event);
}

pub fn spawn_download(
    app: AppHandle,
    session_id: String,
    remote_path: String,
    local_path: String,
) -> AppResult<String> {
    let id = uuid::Uuid::new_v4().to_string();
    let name = Path::new(&remote_path)
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| remote_path.clone());
    let cancel = Arc::new(AtomicBool::new(false));
    app.state::<AppState>()
        .transfers
        .register(&id, cancel.clone());

    let transfer_id = id.clone();
    tauri::async_runtime::spawn(async move {
        let app_handle = app.clone();
        let outcome = download(
            &app_handle,
            &session_id,
            &remote_path,
            &local_path,
            &transfer_id,
            &name,
            &cancel,
        )
        .await;
        finish(&app_handle, &transfer_id, "download", &name, outcome);
    });

    Ok(id)
}

pub fn spawn_upload(
    app: AppHandle,
    session_id: String,
    local_path: String,
    remote_path: String,
) -> AppResult<String> {
    let id = uuid::Uuid::new_v4().to_string();
    let name = Path::new(&local_path)
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| local_path.clone());
    let cancel = Arc::new(AtomicBool::new(false));
    app.state::<AppState>()
        .transfers
        .register(&id, cancel.clone());

    let transfer_id = id.clone();
    tauri::async_runtime::spawn(async move {
        let app_handle = app.clone();
        let outcome = upload(
            &app_handle,
            &session_id,
            &local_path,
            &remote_path,
            &transfer_id,
            &name,
            &cancel,
        )
        .await;
        finish(&app_handle, &transfer_id, "upload", &name, outcome);
    });

    Ok(id)
}

enum Outcome {
    Done(u64),
    Cancelled(u64),
    Failed(u64, String),
}

fn finish(app: &AppHandle, id: &str, direction: &'static str, name: &str, outcome: Outcome) {
    let state = app.state::<AppState>();
    state.transfers.unregister(id);
    let event = match outcome {
        Outcome::Done(total) => TransferEvent {
            id: id.into(),
            direction,
            name: name.into(),
            transferred: total,
            total,
            status: TransferStatus::Done,
            error: None,
        },
        Outcome::Cancelled(transferred) => TransferEvent {
            id: id.into(),
            direction,
            name: name.into(),
            transferred,
            total: 0,
            status: TransferStatus::Cancelled,
            error: None,
        },
        Outcome::Failed(transferred, error) => TransferEvent {
            id: id.into(),
            direction,
            name: name.into(),
            transferred,
            total: 0,
            status: TransferStatus::Failed,
            error: Some(error),
        },
    };
    emit(app, event);
}

fn progress(
    app: &AppHandle,
    id: &str,
    direction: &'static str,
    name: &str,
    transferred: u64,
    total: u64,
) {
    emit(
        app,
        TransferEvent {
            id: id.into(),
            direction,
            name: name.into(),
            transferred,
            total,
            status: TransferStatus::Running,
            error: None,
        },
    );
}

async fn download(
    app: &AppHandle,
    session_id: &str,
    remote_path: &str,
    local_path: &str,
    id: &str,
    name: &str,
    cancel: &Arc<AtomicBool>,
) -> Outcome {
    let mut transferred = 0_u64;
    let result = async {
        let sftp = session(app, session_id).await?;
        let total = sftp
            .metadata(remote_path)
            .await
            .map(|metadata| metadata.len())
            .unwrap_or(0);
        let mut remote = sftp.open(remote_path).await.map_err(map_sftp)?;
        let mut local = tokio::fs::File::create(local_path).await?;
        let mut buffer = vec![0_u8; CHUNK];
        let mut last_report = 0_u64;

        loop {
            if cancel.load(Ordering::SeqCst) {
                return Ok::<_, AppError>(Outcome::Cancelled(transferred));
            }
            let read = remote.read(&mut buffer).await?;
            if read == 0 {
                break;
            }
            local.write_all(&buffer[..read]).await?;
            transferred += read as u64;
            if transferred - last_report >= PROGRESS_STEP || transferred == total {
                last_report = transferred;
                progress(app, id, "download", name, transferred, total);
            }
        }
        local.flush().await?;
        let _ = sftp.close().await;
        Ok(Outcome::Done(transferred))
    }
    .await;

    match result {
        Ok(outcome) => outcome,
        Err(error) => {
            let _ = tokio::fs::remove_file(local_path).await;
            Outcome::Failed(transferred, error.to_string())
        }
    }
}

async fn upload(
    app: &AppHandle,
    session_id: &str,
    local_path: &str,
    remote_path: &str,
    id: &str,
    name: &str,
    cancel: &Arc<AtomicBool>,
) -> Outcome {
    let mut transferred = 0_u64;
    let result = async {
        let total = tokio::fs::metadata(local_path).await?.len();
        let mut local = tokio::fs::File::open(local_path).await?;
        let sftp = session(app, session_id).await?;
        let mut remote = sftp.create(remote_path).await.map_err(map_sftp)?;
        let mut buffer = vec![0_u8; CHUNK];
        let mut last_report = 0_u64;

        loop {
            if cancel.load(Ordering::SeqCst) {
                return Ok::<_, AppError>(Outcome::Cancelled(transferred));
            }
            let read = local.read(&mut buffer).await?;
            if read == 0 {
                break;
            }
            remote.write_all(&buffer[..read]).await?;
            transferred += read as u64;
            if transferred - last_report >= PROGRESS_STEP || transferred == total {
                last_report = transferred;
                progress(app, id, "upload", name, transferred, total);
            }
        }
        remote.flush().await?;
        let _ = sftp.close().await;
        Ok(Outcome::Done(transferred))
    }
    .await;

    match result {
        Ok(outcome) => outcome,
        Err(error) => Outcome::Failed(transferred, error.to_string()),
    }
}

const MAX_TEXT: u64 = 2 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextFile {
    pub content: String,
    pub size: u64,
}

pub async fn read_text(app: &AppHandle, session_id: &str, path: &str) -> AppResult<TextFile> {
    let sftp = session(app, session_id).await?;
    let metadata = sftp.metadata(path).await.map_err(map_sftp)?;
    let size = metadata.len();
    if size > MAX_TEXT {
        return Err(AppError::Ssh("sftp.fileTooLarge".into()));
    }
    let bytes = sftp.read(path).await.map_err(map_sftp)?;
    let _ = sftp.close().await;

    if bytes.iter().take(8192).any(|byte| *byte == 0) {
        return Err(AppError::Ssh("sftp.binaryFile".into()));
    }

    Ok(TextFile {
        content: String::from_utf8_lossy(&bytes).into_owned(),
        size,
    })
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
    sftp.write(path, content.as_bytes())
        .await
        .map_err(map_sftp)?;
    let _ = sftp.close().await;
    Ok(())
}
pub async fn remote_copy(
    app: &AppHandle,
    session_id: &str,
    from: String,
    to: String,
) -> AppResult<()> {
    let sftp = session(app, session_id).await?;
    copy_remote_entry(&sftp, &from, &to).await?;
    let _ = sftp.close().await;
    Ok(())
}

pub fn local_copy(from: String, to: String) -> AppResult<()> {
    copy_local_entry(&PathBuf::from(from), &PathBuf::from(to))
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

fn copy_local_entry(from: &Path, to: &Path) -> AppResult<()> {
    if from.is_dir() {
        std::fs::create_dir_all(to)?;
        for entry in std::fs::read_dir(from)? {
            let entry = entry?;
            copy_local_entry(&entry.path(), &to.join(entry.file_name()))?;
        }
        return Ok(());
    }
    std::fs::copy(from, to)?;
    Ok(())
}

async fn copy_remote_entry(sftp: &SftpSession, from: &str, to: &str) -> AppResult<()> {
    let metadata = sftp.metadata(from).await.map_err(map_sftp)?;
    if metadata.is_dir() {
        let _ = sftp.create_dir(to).await;
        let children: Vec<String> = sftp
            .read_dir(from)
            .await
            .map_err(map_sftp)?
            .map(|entry| entry.file_name())
            .collect();
        for name in children {
            let child_from = join_remote(from, &name);
            let child_to = join_remote(to, &name);
            Box::pin(copy_remote_entry(sftp, &child_from, &child_to)).await?;
        }
        return Ok(());
    }

    let bytes = sftp.read(from).await.map_err(map_sftp)?;
    sftp.write(to, &bytes).await.map_err(map_sftp)?;
    Ok(())
}

async fn remove_remote_entry(sftp: &SftpSession, path: &str) -> AppResult<()> {
    let metadata = sftp.metadata(path).await.map_err(map_sftp)?;
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
    use super::*;

    fn temp_root(name: &str) -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("tunnelde-sftp-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).expect("root");
        root
    }

    #[test]
    fn copies_and_removes_folders_recursively() {
        let root = temp_root("copy");
        let source = root.join("source");
        std::fs::create_dir_all(source.join("nested")).expect("nested");
        std::fs::write(source.join("a.txt"), "a").expect("a");
        std::fs::write(source.join("nested").join("b.txt"), "b").expect("b");

        let target = root.join("target");
        copy_local_entry(&source, &target).expect("copy");
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
    fn joins_remote_paths() {
        assert_eq!(join_remote("/home/user", "a"), "/home/user/a");
        assert_eq!(join_remote("/", "a"), "/a");
    }
}
