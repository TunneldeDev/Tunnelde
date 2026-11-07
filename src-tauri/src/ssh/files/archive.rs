//! Bounded in-memory archives for small files. The ordinary durable path still
//! creates each staging file, owns its journal, verifies sources and publishes
//! each destination. The archive worker only reads sources or fills those
//! already-created, empty staging files; it never extracts arbitrary paths.
use super::*;
use std::io::{Cursor, Read};
use std::sync::Mutex;
use tokio::sync::{oneshot, OnceCell};

pub(super) const MAX_FILE: u64 = 64 * 1024;
const MAX_FILES: usize = 8;
const MAX_ARCHIVE: usize = 1024 * 1024;

#[derive(serde::Serialize)]
pub(super) struct Entry {
    pub path: String,
    pub length: u64,
}

struct Job {
    source: Endpoint,
    destination: Endpoint,
    target: Endpoint,
    length: u64,
    reply: oneshot::Sender<AppResult<bool>>,
}

struct Channels {
    source: Option<compressed::Session>,
    target: Option<compressed::Session>,
}

async fn connect(
    app: &AppHandle,
    endpoint: &Endpoint,
    sftp: Option<&SftpSession>,
) -> AppResult<Option<compressed::Session>> {
    match (&endpoint.session, sftp) {
        (Some(id), Some(sftp)) => tokio::time::timeout(
            std::time::Duration::from_secs(5),
            compressed::Session::connect(app, id, sftp),
        )
        .await
        .map_err(|_| invalid_archive())?
        .map(Some),
        (None, None) => Ok(None),
        _ => Err(invalid_archive()),
    }
}

#[derive(Default)]
pub(super) struct Batcher {
    pending: Mutex<Vec<Job>>,
    channels: OnceCell<Option<Channels>>,
    limited: AtomicBool,
}

fn invalid_archive() -> AppError {
    AppError::Ssh("sftp.compressionProtocol".into())
}

pub(super) fn pack(files: Vec<Vec<u8>>) -> AppResult<Vec<u8>> {
    if files.is_empty() || files.len() > MAX_FILES {
        return Err(invalid_archive());
    }
    let mut archive = tar::Builder::new(Vec::new());
    for (index, file) in files.into_iter().enumerate() {
        if file.len() as u64 > MAX_FILE {
            return Err(invalid_archive());
        }
        let mut header = tar::Header::new_ustar();
        header.set_size(file.len() as u64);
        header.set_mode(0o600);
        header.set_cksum();
        archive.append_data(&mut header, index.to_string(), Cursor::new(file))?;
    }
    let bytes = archive.into_inner()?;
    if bytes.len() > MAX_ARCHIVE {
        return Err(invalid_archive());
    }
    Ok(bytes)
}

pub(super) fn unpack(bytes: Vec<u8>, lengths: &[u64]) -> AppResult<Vec<Vec<u8>>> {
    if bytes.len() > MAX_ARCHIVE || lengths.is_empty() || lengths.len() > MAX_FILES {
        return Err(invalid_archive());
    }
    let mut archive = tar::Archive::new(Cursor::new(bytes));
    let mut entries = archive.entries()?.raw(true);
    let mut files = Vec::with_capacity(lengths.len());
    for (index, length) in lengths.iter().copied().enumerate() {
        if length > MAX_FILE {
            return Err(invalid_archive());
        }
        let mut file = entries.next().ok_or_else(invalid_archive)??;
        // Inspect the raw header: extended paths, links and traversal must not
        // be interpreted by a filesystem extractor, even on a hostile peer.
        if !file.header().entry_type().is_file()
            || file.header().path_bytes().as_ref() != index.to_string().as_bytes()
            || file.header().size()? != length
        {
            return Err(invalid_archive());
        }
        let mut data = Vec::with_capacity(length as usize);
        file.read_to_end(&mut data)?;
        if data.len() as u64 != length {
            return Err(invalid_archive());
        }
        files.push(data);
    }
    if entries.next().is_some() {
        return Err(invalid_archive());
    }
    Ok(files)
}

async fn local_file(path: &str, write: bool) -> AppResult<tokio::fs::File> {
    let path = path.to_owned();
    let file = tokio::task::spawn_blocking(move || -> AppResult<std::fs::File> {
        #[cfg(windows)]
        let file = {
            use std::os::windows::fs::OpenOptionsExt;
            use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT;
            let file = std::fs::OpenOptions::new()
                .read(!write)
                .write(write)
                .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
                .open(&path)?;
            crate::platform::guarded_file::identity(&file)?;
            file
        };
        #[cfg(unix)]
        let file = {
            use rustix::fs::{open, Mode, OFlags};
            let access = if write {
                OFlags::WRONLY
            } else {
                OFlags::RDONLY
            };
            std::fs::File::from(
                open(
                    path.as_str(),
                    access | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
                    Mode::empty(),
                )
                .map_err(std::io::Error::from)?,
            )
        };
        if !file.metadata()?.is_file() {
            return Err(AppError::validation("sftp.fileTypeUnsupported"));
        }
        Ok(file)
    })
    .await
    .map_err(|_| invalid_archive())??;
    Ok(tokio::fs::File::from_std(file))
}

async fn read_local(path: &str, length: u64) -> AppResult<Vec<u8>> {
    let file = local_file(path, false).await?;
    if file.metadata().await?.len() != length {
        return Err(AppError::validation("sftp.resumeSourceChanged"));
    }
    let mut data = Vec::with_capacity(length as usize);
    tokio::io::AsyncReadExt::take(file, length + 1)
        .read_to_end(&mut data)
        .await?;
    if data.len() as u64 != length {
        return Err(AppError::validation("sftp.resumeSourceChanged"));
    }
    Ok(data)
}

impl Batcher {
    #[allow(clippy::too_many_arguments)]
    pub async fn copy(
        &self,
        app: &AppHandle,
        source: &Endpoint,
        destination: &Endpoint,
        target: &Endpoint,
        source_sftp: Option<&SftpSession>,
        target_sftp: Option<&SftpSession>,
        length: u64,
        throttle: bandwidth::Throttle,
        cancel: &AtomicBool,
        compression: bool,
    ) -> AppResult<bool> {
        if length > MAX_FILE || self.limited.load(Ordering::Relaxed) {
            return Ok(false);
        }
        for endpoint in [source, target] {
            if serde_json::to_vec(&Entry {
                path: endpoint.path.clone(),
                length,
            })?
            .len()
                > 1600
            {
                return Ok(false);
            }
        }
        if cancel.load(Ordering::SeqCst) {
            return Err(AppError::Ssh(CANCELLED.into()));
        }
        let (reply, result) = oneshot::channel();
        self.pending.lock().unwrap().push(Job {
            source: source.clone(),
            destination: destination.clone(),
            target: target.clone(),
            length,
            reply,
        });
        // A partial group must flush even when another directory worker is
        // busy with a large file or fails before reaching this rendezvous.
        tokio::time::sleep(std::time::Duration::from_millis(2)).await;
        let jobs: Vec<_> = {
            let mut pending = self.pending.lock().unwrap();
            let count = pending.len().min(MAX_FILES);
            pending.drain(..count).collect()
        };
        if !jobs.is_empty() {
            let copied = self
                .copy_group(
                    app,
                    &jobs,
                    source_sftp,
                    target_sftp,
                    &throttle,
                    cancel,
                    compression,
                )
                .await;
            // AppError is not Clone. Preserve the first exact error and pass
            // its display message to siblings, all of which must drain before
            // the directory owner can pause or clean up staging files.
            let failure = copied.as_ref().err().map(ToString::to_string);
            let success = copied.as_ref().ok().copied().unwrap_or(false);
            let mut original = copied.err();
            for job in jobs {
                let result = match original.take() {
                    Some(error) => Err(error),
                    None => match &failure {
                        Some(message) => Err(AppError::Ssh(message.clone())),
                        None => Ok(success),
                    },
                };
                let _ = job.reply.send(result);
            }
        }
        result.await.map_err(|_| invalid_archive())?
    }

    #[allow(clippy::too_many_arguments)]
    async fn copy_group(
        &self,
        app: &AppHandle,
        jobs: &[Job],
        source_sftp: Option<&SftpSession>,
        target_sftp: Option<&SftpSession>,
        throttle: &bandwidth::Throttle,
        cancel: &AtomicBool,
        compression: bool,
    ) -> AppResult<bool> {
        if jobs.len() < 2 {
            return Ok(false);
        }
        if cancel.load(Ordering::SeqCst) {
            return Err(AppError::Ssh(CANCELLED.into()));
        }
        let channels = interruptible(Some(cancel), async {
            Ok(self
                .channels
                .get_or_init(|| async {
                    let (source, target) = tokio::join!(
                        connect(app, &jobs[0].source, source_sftp),
                        connect(app, &jobs[0].target, target_sftp)
                    );
                    match (source, target) {
                        (Ok(source), Ok(target)) => Some(Channels { source, target }),
                        _ => {
                            tracing::debug!(
                                "Small-file archive worker unavailable; retaining SFTP pipeline"
                            );
                            None
                        }
                    }
                })
                .await)
        })
        .await?;
        let Some(channels) = channels else {
            return Ok(false);
        };
        let total = jobs.iter().map(|job| job.length as usize).sum();
        let direction = match (channels.source.is_some(), channels.target.is_some()) {
            (true, true) => bandwidth::Direction::Both,
            (true, false) => bandwidth::Direction::Download,
            (false, true) => bandwidth::Direction::Upload,
            (false, false) => return Ok(false),
        };
        // Archives are one bounded packet. If a live/global limit only grants
        // a smaller packet, use the ordinary range pipeline for this task.
        // Never accumulate permits and then burst an entire archive later.
        if throttle.acquire(direction, total, cancel).await? != total {
            self.limited.store(true, Ordering::Relaxed);
            return Ok(false);
        }
        let lengths: Vec<_> = jobs.iter().map(|job| job.length).collect();
        let files = if let Some(source) = &channels.source {
            let entries = jobs
                .iter()
                .map(|job| Entry {
                    path: job.source.path.clone(),
                    length: job.length,
                })
                .collect();
            interruptible(Some(cancel), source.read_archive(entries, compression)).await?
        } else {
            let mut files = Vec::with_capacity(jobs.len());
            for job in jobs {
                let file =
                    interruptible(Some(cancel), read_local(&job.source.path, job.length)).await?;
                files.push(file);
            }
            files
        };
        if files
            .iter()
            .map(|file| file.len() as u64)
            .collect::<Vec<_>>()
            != lengths
        {
            return Err(invalid_archive());
        }
        if cancel.load(Ordering::SeqCst) {
            return Err(AppError::Ssh(CANCELLED.into()));
        }
        if let Some(target) = &channels.target {
            let entries = jobs
                .iter()
                .map(|job| Entry {
                    path: job.target.path.clone(),
                    length: job.length,
                })
                .collect();
            let owned: Vec<_> = jobs
                .iter()
                .map(|job| (&job.destination, &job.target))
                .collect();
            artifacts::archive_pending(app, &throttle.id, &owned, true)?;
            // An interrupted operation leaves its generation marked uncertain.
            // Recovery unlinks it and allocates a new name before writing.
            tracing::debug!(id = %throttle.id, "Awaiting archive destination acknowledgement");
            let written = interruptible(
                Some(cancel),
                target.write_archive(entries, files, compression),
            )
            .await;
            if let Err(error) = written {
                target.abort();
                return Err(error);
            }
            artifacts::archive_pending(app, &throttle.id, &owned, false)?;
        } else {
            // Open every staging object before the first write. They were
            // created exclusively and recorded by durable_copy_file already.
            let mut targets = Vec::with_capacity(jobs.len());
            for job in jobs {
                let target = local_file(&job.target.path, true).await?;
                let metadata = target.metadata().await?;
                if !metadata.is_file() || metadata.len() != 0 {
                    return Err(AppError::validation("sftp.resumePrefixMismatch"));
                }
                targets.push(target);
            }
            for (mut target, data) in targets.into_iter().zip(files) {
                target.write_all(&data).await?;
                target.flush().await?;
            }
        }
        tracing::debug!(
            id = %throttle.id,
            files = jobs.len(),
            bytes = total,
            "Transferred small-file archive"
        );
        Ok(true)
    }
}

#[cfg(test)]
mod tests;
