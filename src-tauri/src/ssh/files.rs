// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use russh_sftp::client::SftpSession;
use russh_sftp::protocol::{OpenFlags, StatusCode};
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
    overwrite: bool,
) -> AppResult<()> {
    let sftp = session(app, session_id).await?;
    let result = async {
        check_remote_destination(&sftp, &from, &to, overwrite).await?;
        if remote_exists(&sftp, &to).await? {
            copy_remote_entry(&sftp, &from, &to, overwrite).await?;
            return remove_remote_entry(&sftp, &from).await;
        }
        sftp.rename(from, to).await.map_err(map_sftp)
    }
    .await;
    let _ = sftp.close().await;
    result
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

impl Outcome {
    fn from_result(result: AppResult<()>, transferred: u64, cancel: &AtomicBool) -> Self {
        match result {
            Ok(()) => Self::Done(transferred),
            Err(_) if cancel.load(Ordering::SeqCst) => Self::Cancelled(transferred),
            Err(error) => Self::Failed(transferred, error.to_string()),
        }
    }
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
    overwrite: bool,
) -> AppResult<String> {
    if from.session == to.session && from.path == to.path {
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
        let outcome = run(
            &app_handle,
            &from,
            &to,
            &transfer_id,
            &name,
            &cancel,
            TransferOptions {
                remove_source,
                overwrite,
            },
        )
        .await;
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
    Remote(Box<russh_sftp::client::fs::File>),
}

impl Reader {
    async fn read(&mut self, buffer: &mut [u8]) -> AppResult<usize> {
        Ok(match self {
            Reader::Local(file) => file.read(buffer).await?,
            Reader::Remote(file) => file.read(buffer).await?,
        })
    }

    async fn finish(self) -> AppResult<()> {
        if let Reader::Remote(file) = self {
            file.close().await?;
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
            Writer::Remote(file) => finish_remote_file(*file).await?,
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
            (metadata.is_dir(), metadata.is_symlink())
        }
    };
    if symlink {
        return Err(AppError::validation("sftp.symlinkUnsupported"));
    }
    Ok(directory)
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

async fn copy_entry(
    from: &Endpoint,
    to: &Endpoint,
    from_sftp: Option<&SftpSession>,
    to_sftp: Option<&SftpSession>,
    meter: &mut Meter<'_>,
    cancel: &Arc<AtomicBool>,
    overwrite: bool,
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
            ))
            .await?;
        }
        return Ok(());
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

async fn remove_endpoint(endpoint: &Endpoint, sftp: Option<&SftpSession>) -> AppResult<()> {
    match sftp {
        Some(handle) => remove_remote_entry(handle, &endpoint.path).await,
        None => remove_local_entry(&PathBuf::from(&endpoint.path)),
    }
}

struct TransferOptions {
    remove_source: bool,
    overwrite: bool,
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
    let TransferOptions {
        remove_source,
        overwrite,
    } = options;
    // SFTP v3 rename cannot replace existing targets. Confirmed overwrites use
    // the copy/merge path below and only remove the source after completion.
    if remove_source && !overwrite {
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
        if from.session == to.session {
            match from_sftp.as_ref() {
                Some(sftp) => {
                    check_remote_destination(sftp, &from.path, &to.path, overwrite).await?
                }
                None => {
                    check_local_destination(Path::new(&from.path), Path::new(&to.path), overwrite)?
                }
            }
        } else if !overwrite {
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
        )
        .await?;
        if cancel.load(Ordering::SeqCst) {
            return Err(AppError::Ssh(CANCELLED.into()));
        }
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
    if from.is_dir() {
        std::fs::create_dir_all(to)?;
        for entry in std::fs::read_dir(from)? {
            let entry = entry?;
            if entry.file_type()?.is_symlink() {
                return Err(AppError::validation("sftp.symlinkUnsupported"));
            }
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
    use super::*;

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

        #[derive(Default)]
        struct State {
            closes: AtomicUsize,
            fail_write: AtomicBool,
            fail_close: AtomicBool,
            delay_close: AtomicBool,
            close_started: Notify,
            release_close: Notify,
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
                let file = self.handles.get_mut(&handle).ok_or(StatusCode::Failure)?;
                file.seek(SeekFrom::Start(offset)).map_err(io_status)?;
                let mut data = vec![0; len as usize];
                let read = file.read(&mut data).map_err(io_status)?;
                if read == 0 {
                    return Err(StatusCode::Eof);
                }
                data.truncate(read);
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
                self.stat(id, path).await
            }
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
