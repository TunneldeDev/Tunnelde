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
const CANCELLED: &str = "sftp.cancelled";

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

pub fn local_create_file(path: String) -> AppResult<()> {
    std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(Path::new(&path))?;
    Ok(())
}

pub async fn remote_create_file(app: &AppHandle, session_id: &str, path: String) -> AppResult<()> {
    let sftp = session(app, session_id).await?;
    sftp.write(&path, b"").await.map_err(map_sftp)?;
    let _ = sftp.close().await;
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
            error: None,
        },
    );
}

enum Outcome {
    Done(u64),
    Cancelled(u64),
    Failed(u64, String),
}

fn finish(app: &AppHandle, id: &str, name: &str, outcome: Outcome) {
    let state = app.state::<AppState>();
    state.transfers.unregister(id);
    let event = match outcome {
        Outcome::Done(total) => TransferEvent {
            id: id.into(),
            direction: "transfer",
            name: name.into(),
            transferred: total,
            total,
            status: TransferStatus::Done,
            error: None,
        },
        Outcome::Cancelled(transferred) => TransferEvent {
            id: id.into(),
            direction: "transfer",
            name: name.into(),
            transferred,
            total: 0,
            status: TransferStatus::Cancelled,
            error: None,
        },
        Outcome::Failed(transferred, error) => TransferEvent {
            id: id.into(),
            direction: "transfer",
            name: name.into(),
            transferred,
            total: 0,
            status: TransferStatus::Failed,
            error: Some(error),
        },
    };
    emit(app, event);
}

/// Copies one endpoint onto another, whatever the two sides are: disk to disk,
/// disk to a server, server to disk or between two servers. Folders are walked
/// recursively and any single failure aborts the whole operation.
pub fn spawn_transfer(
    app: AppHandle,
    from: Endpoint,
    to: Endpoint,
    remove_source: bool,
) -> AppResult<String> {
    if from.session.is_some() && from.session == to.session && from.path == to.path {
        return Err(AppError::validation("sftp.samePath"));
    }

    let id = uuid::Uuid::new_v4().to_string();
    let name = file_name_of(&from.path);
    let cancel = Arc::new(AtomicBool::new(false));
    app.state::<AppState>()
        .transfers
        .register(&id, cancel.clone());

    let transfer_id = id.clone();
    tauri::async_runtime::spawn(async move {
        let app_handle = app.clone();
        let outcome = run(&app_handle, &from, &to, &transfer_id, &name, &cancel, remove_source).await;
        finish(&app_handle, &transfer_id, &name, outcome);
    });

    Ok(id)
}

struct Meter<'a> {
    app: &'a AppHandle,
    id: &'a str,
    name: &'a str,
    transferred: u64,
    total: u64,
    last: u64,
}

impl<'a> Meter<'a> {
    fn new(app: &'a AppHandle, id: &'a str, name: &'a str, total: u64) -> Self {
        Self {
            app,
            id,
            name,
            transferred: 0,
            total,
            last: 0,
        }
    }

    fn add(&mut self, bytes: u64) {
        self.transferred += bytes;
        if self.transferred - self.last >= PROGRESS_STEP || self.transferred >= self.total {
            self.last = self.transferred;
            progress(self.app, self.id, self.name, self.transferred, self.total);
        }
    }
}

enum Reader {
    Local(tokio::fs::File),
    Remote(russh_sftp::client::fs::File),
}

impl Reader {
    async fn read(&mut self, buffer: &mut [u8]) -> AppResult<usize> {
        Ok(match self {
            Reader::Local(file) => file.read(buffer).await?,
            Reader::Remote(file) => file.read(buffer).await?,
        })
    }
}

enum Writer {
    Local(tokio::fs::File),
    Remote(russh_sftp::client::fs::File),
}

impl Writer {
    async fn write_all(&mut self, buffer: &[u8]) -> AppResult<()> {
        match self {
            Writer::Local(file) => file.write_all(buffer).await?,
            Writer::Remote(file) => file.write_all(buffer).await?,
        }
        Ok(())
    }

    async fn finish(mut self) -> AppResult<()> {
        match &mut self {
            Writer::Local(file) => file.flush().await?,
            Writer::Remote(file) => file.flush().await?,
        }
        Ok(())
    }
}

async fn is_dir(endpoint: &Endpoint, sftp: Option<&SftpSession>) -> AppResult<bool> {
    match sftp {
        Some(handle) => Ok(handle
            .metadata(&endpoint.path)
            .await
            .map_err(map_sftp)?
            .is_dir()),
        None => Ok(tokio::fs::metadata(&endpoint.path).await?.is_dir()),
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
    match sftp {
        Some(handle) => {
            let _ = handle.create_dir(&endpoint.path).await;
            Ok(())
        }
        None => {
            tokio::fs::create_dir_all(&endpoint.path).await?;
            Ok(())
        }
    }
}

async fn measure(endpoint: &Endpoint, sftp: Option<&SftpSession>) -> AppResult<u64> {
    if is_dir(endpoint, sftp).await? {
        let mut total = 0;
        for path in children(endpoint, sftp).await? {
            total += Box::pin(measure(&endpoint.child(path), sftp)).await?;
        }
        return Ok(total);
    }
    Ok(match sftp {
        Some(handle) => handle
            .metadata(&endpoint.path)
            .await
            .map(|metadata| metadata.len())
            .unwrap_or(0),
        None => tokio::fs::metadata(&endpoint.path)
            .await
            .map(|metadata| metadata.len())
            .unwrap_or(0),
    })
}

async fn open_reader(endpoint: &Endpoint, sftp: Option<&SftpSession>) -> AppResult<Reader> {
    Ok(match sftp {
        Some(handle) => Reader::Remote(handle.open(&endpoint.path).await.map_err(map_sftp)?),
        None => Reader::Local(tokio::fs::File::open(&endpoint.path).await?),
    })
}

async fn open_writer(endpoint: &Endpoint, sftp: Option<&SftpSession>) -> AppResult<Writer> {
    Ok(match sftp {
        Some(handle) => Writer::Remote(handle.create(&endpoint.path).await.map_err(map_sftp)?),
        None => Writer::Local(tokio::fs::File::create(&endpoint.path).await?),
    })
}

async fn copy_entry(
    from: &Endpoint,
    to: &Endpoint,
    from_sftp: Option<&SftpSession>,
    to_sftp: Option<&SftpSession>,
    meter: &mut Meter<'_>,
    cancel: &Arc<AtomicBool>,
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
                &child_from, &child_to, from_sftp, to_sftp, meter, cancel,
            ))
            .await?;
        }
        return Ok(());
    }

    let mut reader = open_reader(from, from_sftp).await?;
    let mut writer = open_writer(to, to_sftp).await?;
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
    writer.finish().await?;
    Ok(())
}

async fn remove_endpoint(endpoint: &Endpoint, sftp: Option<&SftpSession>) -> AppResult<()> {
    match sftp {
        Some(handle) => remove_remote_entry(handle, &endpoint.path).await,
        None => remove_local_entry(&PathBuf::from(&endpoint.path)),
    }
}

async fn run(
    app: &AppHandle,
    from: &Endpoint,
    to: &Endpoint,
    id: &str,
    name: &str,
    cancel: &Arc<AtomicBool>,
    remove_source: bool,
) -> Outcome {
    // Moving inside one server is a rename the server can do itself.
    if let (Some(from_session), Some(to_session)) = (&from.session, &to.session) {
        if from_session == to_session {
            let sftp = match session(app, from_session).await {
                Ok(value) => value,
                Err(error) => return Outcome::Failed(0, error.to_string()),
            };
            let total = measure(from, Some(&sftp)).await.unwrap_or(0);
            progress(app, id, name, 0, total);
            let result = async {
                copy_remote_entry(&sftp, &from.path, &to.path).await?;
                if remove_source {
                    remove_remote_entry(&sftp, &from.path).await?;
                }
                Ok::<(), AppError>(())
            }
            .await;
            let _ = sftp.close().await;
            return match result {
                Ok(()) => Outcome::Done(total),
                Err(error) => Outcome::Failed(0, error.to_string()),
            };
        }
    }

    let from_sftp = match &from.session {
        Some(session_id) => match session(app, session_id).await {
            Ok(value) => Some(value),
            Err(error) => return Outcome::Failed(0, error.to_string()),
        },
        None => None,
    };
    let to_sftp = match &to.session {
        Some(session_id) => match session(app, session_id).await {
            Ok(value) => Some(value),
            Err(error) => return Outcome::Failed(0, error.to_string()),
        },
        None => None,
    };

    let total = measure(from, from_sftp.as_ref()).await.unwrap_or(0);
    progress(app, id, name, 0, total);

    let mut meter = Meter::new(app, id, name, total);
    let result = async {
        copy_entry(
            from,
            to,
            from_sftp.as_ref(),
            to_sftp.as_ref(),
            &mut meter,
            cancel,
        )
        .await?;
        if remove_source {
            remove_endpoint(from, from_sftp.as_ref()).await?;
        }
        Ok::<(), AppError>(())
    }
    .await;

    if let Some(sftp) = from_sftp {
        let _ = sftp.close().await;
    }
    if let Some(sftp) = to_sftp {
        let _ = sftp.close().await;
    }

    match result {
        Ok(()) => Outcome::Done(meter.transferred),
        Err(error) => {
            if cancel.load(Ordering::SeqCst) {
                Outcome::Cancelled(meter.transferred)
            } else {
                Outcome::Failed(meter.transferred, error.to_string())
            }
        }
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
    fn creates_empty_files() {
        let root = temp_root("create");
        let file = root.join("note.txt");
        local_create_file(display_path(&file)).expect("create");
        assert!(file.exists());
        assert_eq!(std::fs::metadata(&file).unwrap().len(), 0);
        let _ = std::fs::remove_dir_all(&root);
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
