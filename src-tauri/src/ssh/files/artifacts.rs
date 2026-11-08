use super::*;
use crate::platform::file_identity::FileIdentity;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Serialize, Deserialize)]
#[serde(untagged)]
enum ArtifactRecord {
    Current {
        path: String,
        identity: Option<FileIdentity>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        archive: Option<ArchiveWrite>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        publication: Option<Publication>,
    },
    Legacy(String),
}

/// Persisted before sending a remote archive. A missing acknowledgement makes
/// this staging generation disposable, never safe to reuse or publish.
#[derive(Default, Serialize, Deserialize)]
struct ArchiveWrite {
    generation: Option<String>,
    pending: bool,
}

#[derive(Default, Serialize, Deserialize)]
struct Publication {
    // Persisted before retiring the original path. A restart retries the same
    // rename pair instead of losing a successfully moved, fully uploaded file.
    successor: Option<String>,
}

impl ArtifactRecord {
    fn into_path(self) -> String {
        match self {
            Self::Current { path, .. } | Self::Legacy(path) => path,
        }
    }

    fn identity(&self) -> Option<&FileIdentity> {
        match self {
            Self::Current { identity, .. } => identity.as_ref(),
            Self::Legacy(_) => None,
        }
    }
}

fn artifact_key(id: &str, to: &Endpoint) -> String {
    format!(
        "transfer-artifact:{id}:{:x}",
        Sha256::digest(to.path.as_bytes())
    )
}

fn artifact_record(app: &AppHandle, id: &str, to: &Endpoint) -> AppResult<Option<ArtifactRecord>> {
    get(app, &artifact_key(id, to))?
        .map(|raw| serde_json::from_str(&raw).map_err(AppError::from))
        .transpose()
}

fn part_from_record(
    to: &Endpoint,
    id: &str,
    record: Option<&ArtifactRecord>,
) -> AppResult<Endpoint> {
    let generation = match record {
        Some(ArtifactRecord::Current {
            archive: Some(archive),
            ..
        }) => archive.generation.as_deref(),
        _ => None,
    };
    let owner = match generation {
        Some(value) => format!(
            "{id}-{}",
            uuid::Uuid::parse_str(value)
                .map_err(|_| AppError::internal("Invalid archive staging generation"))?
        ),
        None => id.to_owned(),
    };
    Ok(staging_endpoint(to, &owner, "part"))
}

/// Retire an uncertain archive before making another writer. The worker only
/// opens existing files: a delayed open now fails, and an already-open writer
/// can only touch the unlinked old inode. The next generation has a fresh path.
pub(super) async fn prepare_staging(
    app: &AppHandle,
    id: &str,
    to: &Endpoint,
    sftp: Option<&SftpSession>,
    cancel: &AtomicBool,
) -> AppResult<(Endpoint, bool)> {
    let mut record = artifact_record(app, id, to)?;
    let temp = part_from_record(to, id, record.as_ref())?;
    let recovering_publication = matches!(
        record,
        Some(ArtifactRecord::Current {
            publication: Some(_),
            ..
        })
    );
    if recovering_publication {
        let sftp = sftp.ok_or_else(|| AppError::internal("Remote publication on local staging"))?;
        let successor = match record.as_mut().unwrap() {
            ArtifactRecord::Current { publication, .. } => publication
                .as_mut()
                .unwrap()
                .successor
                .get_or_insert_with(|| uuid::Uuid::new_v4().to_string())
                .clone(),
            ArtifactRecord::Legacy(_) => unreachable!(),
        };
        // Record the successor before sending the fencing rename. If it runs
        // but its acknowledgement is lost, the next attempt finds this path.
        put(
            app,
            &artifact_key(id, to),
            serde_json::to_string(&record.as_ref().unwrap())?,
        )?;
        let next = publication_successor(to, id, &successor)?;
        if !publication::fence(&temp, &next, sftp, cancel).await? {
            // Keep the uncertainty record until the published target has been
            // verified. A failed verification must remain protected on every
            // later Resume, including after an application restart.
            return Ok((next, true));
        }
        if let Some(ArtifactRecord::Current {
            archive,
            publication,
            ..
        }) = record.as_mut()
        {
            let stage = archive.get_or_insert_with(ArchiveWrite::default);
            stage.generation = Some(successor);
            stage.pending = false;
            *publication = None;
        }
        put(
            app,
            &artifact_key(id, to),
            serde_json::to_string(&record.as_ref().unwrap())?,
        )?;
        return Ok((next, true));
    }
    if let Some(ArtifactRecord::Current {
        archive: Some(archive),
        ..
    }) = record.as_mut()
    {
        if archive.pending {
            if sftp.is_none() {
                return Err(AppError::internal(
                    "Remote archive journal on a local staging file",
                ));
            }
            if interruptible(Some(cancel), file_length(&temp, sftp))
                .await?
                .is_some()
            {
                interruptible(Some(cancel), remove_transfer_file(&temp, sftp)).await?;
            }
            archive.generation = Some(uuid::Uuid::new_v4().to_string());
            archive.pending = false;
            // Persist the generation and discard checkpoints from the retired
            // inode together. Cancellation/crash before this commit retries the
            // old unlink; it can never make the old pathname writable again.
            app.state::<AppState>().db.with(|conn| {
                let tx = conn.unchecked_transaction()?;
                tx.execute(
                    "UPDATE settings SET value=?1,updated_at=?2 WHERE key=?3",
                    rusqlite::params![
                        serde_json::to_string(record.as_ref().unwrap())?,
                        crate::models::now_ms(),
                        artifact_key(id, to)
                    ],
                )?;
                let digest = format!("{:x}", Sha256::digest(to.path.as_bytes()));
                tx.execute(
                    "DELETE FROM settings WHERE key=?1 OR key=?2",
                    rusqlite::params![
                        format!("transfer-part:{id}:{digest}"),
                        format!("transfer-parallel:{id}:{digest}")
                    ],
                )?;
                tx.commit()?;
                Ok(())
            })?;
            return Ok((part_from_record(to, id, record.as_ref())?, false));
        }
    }
    Ok((temp, false))
}

fn publication_successor(to: &Endpoint, id: &str, generation: &str) -> AppResult<Endpoint> {
    let generation = uuid::Uuid::parse_str(generation)
        .map_err(|_| AppError::internal("Invalid publication staging generation"))?;
    Ok(staging_endpoint(to, &format!("{id}-{generation}"), "part"))
}

pub(super) fn begin_publication(
    app: &AppHandle,
    id: &str,
    to: &Endpoint,
    temp: &Endpoint,
) -> AppResult<()> {
    let mut record = artifact_record(app, id, to)?
        .ok_or_else(|| AppError::internal("Missing publication ownership record"))?;
    if to.session.is_none() || part_from_record(to, id, Some(&record))?.path != temp.path {
        return Err(AppError::internal("Publication staging journal mismatch"));
    }
    match &mut record {
        ArtifactRecord::Current { publication, .. } if publication.is_none() => {
            *publication = Some(Publication::default());
        }
        _ => {
            return Err(AppError::internal(
                "Unresolved publication ownership record",
            ))
        }
    }
    put(app, &artifact_key(id, to), serde_json::to_string(&record)?)
}

pub(super) fn confirm_publication(app: &AppHandle, id: &str, to: &Endpoint) -> AppResult<()> {
    if let Some(mut record @ ArtifactRecord::Current { .. }) = artifact_record(app, id, to)? {
        if let ArtifactRecord::Current { publication, .. } = &mut record {
            if publication.take().is_none() {
                return Ok(());
            }
        }
        put(app, &artifact_key(id, to), serde_json::to_string(&record)?)?;
    }
    Ok(())
}

/// One transaction covers every member before the first network write. Clear
/// it only after the worker acknowledges all writes and has closed its handles.
pub(super) fn archive_pending(
    app: &AppHandle,
    id: &str,
    files: &[(&Endpoint, &Endpoint)],
    pending: bool,
) -> AppResult<()> {
    app.state::<AppState>().db.with(|conn| {
        let tx = conn.unchecked_transaction()?;
        for (to, temp) in files {
            let key = artifact_key(id, to);
            let raw: String =
                tx.query_row("SELECT value FROM settings WHERE key=?1", [&key], |r| {
                    r.get(0)
                })?;
            let mut record: ArtifactRecord = serde_json::from_str(&raw)?;
            if to.session.is_none() || part_from_record(to, id, Some(&record))?.path != temp.path {
                return Err(AppError::internal("Archive staging journal mismatch"));
            }
            match &mut record {
                ArtifactRecord::Current { archive, .. } => {
                    archive.get_or_insert_with(ArchiveWrite::default).pending = pending
                }
                ArtifactRecord::Legacy(_) => {
                    return Err(AppError::internal("Unowned archive staging file"))
                }
            }
            tx.execute(
                "UPDATE settings SET value=?1,updated_at=?2 WHERE key=?3",
                rusqlite::params![
                    serde_json::to_string(&record)?,
                    crate::models::now_ms(),
                    key
                ],
            )?;
        }
        tx.commit()?;
        Ok(())
    })
}

#[cfg(windows)]
pub(super) fn pin_local_staging(
    app: &AppHandle,
    id: &str,
    to: &Endpoint,
) -> AppResult<Option<crate::platform::guarded_file::GuardedFile>> {
    if to.session.is_some() {
        return Ok(None);
    }
    let record = artifact_record(app, id, to)?;
    let temp = staging_endpoint(to, id, "part");
    pin_partial(&temp, record.as_ref().and_then(ArtifactRecord::identity))
}

#[cfg(windows)]
fn pin_partial(
    temp: &Endpoint,
    expected: Option<&FileIdentity>,
) -> AppResult<Option<crate::platform::guarded_file::GuardedFile>> {
    use crate::platform::guarded_file::GuardedFile;
    let unrecognized = || AppError::TransferArtifactUnrecognized {
        path: temp.path.clone(),
    };
    let guard = match GuardedFile::pin(Path::new(&temp.path)) {
        Ok(guard) => guard,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) if error.kind() == std::io::ErrorKind::InvalidInput => {
            return Err(unrecognized())
        }
        Err(error) => return Err(error.into()),
    };
    let expected = expected.ok_or_else(unrecognized)?;
    if guard.identity()? != *expected {
        return Err(unrecognized());
    }
    Ok(Some(guard))
}

#[cfg(windows)]
pub(super) fn record_local_writer(
    app: &AppHandle,
    id: &str,
    to: &Endpoint,
    writer: &Writer,
    created: bool,
    pinned: &mut Option<crate::platform::guarded_file::GuardedFile>,
) -> AppResult<()> {
    use crate::platform::guarded_file::{identity, GuardedFile};
    let Writer::Local(file) = writer else {
        return Ok(());
    };
    let current = identity(file)?;
    let temp = staging_endpoint(to, id, "part");
    if created {
        // The handle identifies the object CREATE_NEW actually created, not
        // whatever another process may have put at its path in the meantime.
        put(
            app,
            &artifact_key(id, to),
            serde_json::to_string(&ArtifactRecord::Current {
                path: to.path.clone(),
                identity: Some(current.clone()),
                archive: None,
                publication: None,
            })?,
        )?;
        let guard = GuardedFile::pin(Path::new(&temp.path))?;
        if guard.identity()? != current {
            return Err(AppError::TransferArtifactUnrecognized { path: temp.path });
        }
        *pinned = Some(guard);
    } else {
        let guard = pinned
            .as_ref()
            .ok_or_else(|| AppError::TransferArtifactUnrecognized {
                path: temp.path.clone(),
            })?;
        if guard.identity()? != current {
            return Err(AppError::TransferArtifactUnrecognized { path: temp.path });
        }
    }
    Ok(())
}

#[derive(Serialize, Deserialize)]
struct ResumeCheckpoint {
    source: (u64, Option<i64>),
    partial: (u64, Option<i64>),
}

#[derive(Serialize, Deserialize)]
struct ParallelCheckpoint {
    source: (u64, Option<i64>),
    offset: u64,
}

pub(super) fn begin_window(
    app: &AppHandle,
    key: &str,
    source: (u64, Option<i64>),
    offset: u64,
) -> AppResult<()> {
    put(
        app,
        &key.replacen("transfer-file:", "transfer-parallel:", 1),
        serde_json::to_string(&ParallelCheckpoint { source, offset })?,
    )
}

pub(super) fn end_window(app: &AppHandle, key: &str) -> AppResult<()> {
    app.state::<AppState>().db.with(|conn| {
        conn.execute(
            "DELETE FROM settings WHERE key=?1",
            [key.replacen("transfer-file:", "transfer-parallel:", 1)],
        )?;
        Ok(())
    })
}

pub(super) async fn recover_window(
    app: &AppHandle,
    key: &str,
    source: (u64, Option<i64>),
    temp: &Endpoint,
    sftp: Option<&SftpSession>,
    cancel: Option<&AtomicBool>,
) -> AppResult<()> {
    let marker = get(
        app,
        &key.replacen("transfer-file:", "transfer-parallel:", 1),
    )?;
    let Some(marker) = marker else { return Ok(()) };
    let checkpoint: ParallelCheckpoint = serde_json::from_str(&marker)?;
    restore_window_prefix(checkpoint, source, temp, sftp, cancel).await?;
    end_window(app, key)
}

async fn restore_window_prefix(
    checkpoint: ParallelCheckpoint,
    source: (u64, Option<i64>),
    temp: &Endpoint,
    sftp: Option<&SftpSession>,
    cancel: Option<&AtomicBool>,
) -> AppResult<()> {
    if checkpoint.source != source || checkpoint.offset > source.0 {
        return Err(AppError::validation("sftp.resumeSourceChanged"));
    }
    let length = interruptible(cancel, file_length(temp, sftp))
        .await?
        .unwrap_or(0);
    if length < checkpoint.offset {
        return Err(AppError::validation("sftp.resumePrefixMismatch"));
    }
    if length > checkpoint.offset {
        if cancel.is_some_and(|flag| flag.load(Ordering::SeqCst)) {
            return Err(AppError::Ssh(CANCELLED.into()));
        }
        // Discard sparse or partially acknowledged writes from the interrupted
        // window before any prefix can be trusted as resumable data.
        segments::resize(temp, sftp, checkpoint.offset).await?;
    }
    Ok(())
}

fn get(app: &AppHandle, key: &str) -> AppResult<Option<String>> {
    app.state::<AppState>().db.with(|conn| {
        Ok(conn
            .query_row("SELECT value FROM settings WHERE key=?1", [key], |r| {
                r.get(0)
            })
            .optional()?)
    })
}

fn put(app: &AppHandle, key: &str, value: String) -> AppResult<()> {
    app.state::<AppState>().db.with(|conn| {
        conn.execute("INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
            rusqlite::params![key, value, crate::models::now_ms()])?;
        Ok(())
    })
}

pub(super) fn record(app: &AppHandle, id: &str, to: &Endpoint) -> AppResult<()> {
    let key = artifact_key(id, to);
    // A resumed writer must never replace its original ownership record.
    if get(app, &key)?.is_some() {
        return Ok(());
    }
    put(
        app,
        &key,
        serde_json::to_string(&ArtifactRecord::Current {
            path: to.path.clone(),
            identity: None,
            archive: None,
            publication: None,
        })?,
    )
}

pub(super) async fn checkpoint(
    app: &AppHandle,
    key: &str,
    source: (u64, Option<i64>),
    temp: &Endpoint,
    sftp: Option<&SftpSession>,
    submitted: std::ops::RangeInclusive<u64>,
) -> AppResult<()> {
    let partial = source_stamp(temp, sftp).await?;
    if submitted.contains(&partial.0) && partial.0 <= source.0 {
        put(
            app,
            &key.replacen("transfer-file:", "transfer-part:", 1),
            serde_json::to_string(&ResumeCheckpoint { source, partial })?,
        )?;
    } else {
        return Err(AppError::validation("sftp.resumePrefixMismatch"));
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
pub(super) async fn resume_offset(
    app: &AppHandle,
    key: &str,
    source: (u64, Option<i64>),
    temp: &Endpoint,
    sftp: Option<&SftpSession>,
    reader: &mut Reader,
    existing: u64,
    cancel: &AtomicBool,
) -> AppResult<()> {
    let saved = get(app, &key.replacen("transfer-file:", "transfer-part:", 1))?
        .and_then(|raw| serde_json::from_str::<ResumeCheckpoint>(&raw).ok());
    let unchanged = if let Some(saved) = saved {
        saved.source == source
            && source.1.is_some()
            && saved.partial.0 == existing
            && saved.partial.1.is_some()
            && saved.partial == interruptible(Some(cancel), source_stamp(temp, sftp)).await?
    } else {
        false
    };
    verify_resume(reader, temp, sftp, existing, unchanged, cancel).await
}

async fn verify_resume(
    reader: &mut Reader,
    temp: &Endpoint,
    sftp: Option<&SftpSession>,
    existing: u64,
    unchanged: bool,
    cancel: &AtomicBool,
) -> AppResult<()> {
    if unchanged {
        // A cleanly closed staging file is our checkpoint. Check its boundaries
        // against the unchanged source instead of downloading gigabytes again.
        let head = existing.min(CHUNK as u64);
        verify_range(reader, temp, sftp, 0, head, Some(cancel)).await?;
        let offset = head.max(existing.saturating_sub(CHUNK as u64));
        verify_range(reader, temp, sftp, offset, existing - offset, Some(cancel)).await?;
    } else {
        // Crashes, legacy records and externally changed staging files retain
        // the complete byte-for-byte verification path.
        verify_prefix(reader, temp, sftp, existing, Some(cancel)).await?;
    }
    reader.seek(existing).await
}

fn recorded_paths(app: &AppHandle, id: &str) -> AppResult<Vec<String>> {
    app.state::<AppState>().db.with(|conn| {
        let mut query = conn.prepare("SELECT value FROM settings WHERE instr(key,?1)=1")?;
        let values = query.query_map([format!("transfer-artifact:{id}:")], |r| {
            r.get::<_, String>(0)
        })?;
        let mut paths = Vec::new();
        for raw in values {
            paths.push(serde_json::from_str::<ArtifactRecord>(&raw?)?.into_path());
        }
        Ok(paths)
    })
}

async fn cleanup_file(
    app: &AppHandle,
    id: &str,
    to: &Endpoint,
    sftp: Option<&SftpSession>,
) -> AppResult<()> {
    if get(
        app,
        &format!(
            "transfer-file:{id}:{:x}",
            Sha256::digest(to.path.as_bytes())
        ),
    )?
    .is_none()
    {
        return Ok(());
    }
    let key = format!(
        "transfer-backup:{id}:{:x}",
        Sha256::digest(to.path.as_bytes())
    );
    let artifact = artifact_record(app, id, to)?;
    let temp = part_from_record(to, id, artifact.as_ref())?;
    cleanup_at(
        id,
        to,
        &temp,
        sftp,
        backup_checkpoint(app, &key)?.as_ref(),
        artifact.as_ref().and_then(ArtifactRecord::identity),
    )
    .await?;
    if let Some(ArtifactRecord::Current {
        publication: Some(Publication {
            successor: Some(generation),
        }),
        ..
    }) = artifact.as_ref()
    {
        let next = publication_successor(to, id, generation)?;
        if file_length(&next, sftp).await?.is_some() {
            cleanup_partial(&next, sftp, None).await?;
        }
    }
    Ok(())
}

#[cfg(test)]
pub(super) async fn cleanup_owned(
    id: &str,
    to: &Endpoint,
    sftp: Option<&SftpSession>,
    expected: Option<&BackupFingerprint>,
    identity: Option<&FileIdentity>,
) -> AppResult<()> {
    let temp = staging_endpoint(to, id, "part");
    cleanup_at(id, to, &temp, sftp, expected, identity).await
}

async fn cleanup_at(
    id: &str,
    to: &Endpoint,
    temp: &Endpoint,
    sftp: Option<&SftpSession>,
    expected: Option<&BackupFingerprint>,
    identity: Option<&FileIdentity>,
) -> AppResult<()> {
    let backup = staging_endpoint(to, id, "backup");
    let cancel = AtomicBool::new(false);
    if file_length(&backup, sftp).await?.is_some() {
        let recovery = || AppError::BackupRecovery {
            backup: backup.path.clone(),
            destination: to.path.clone(),
        };
        let unrecognized = || AppError::BackupUnrecognized {
            backup: backup.path.clone(),
            destination: to.path.clone(),
        };
        let expected = expected.ok_or_else(unrecognized)?;
        if fingerprint_file(&backup, sftp, &cancel).await? != *expected {
            return Err(unrecognized());
        }
        // Checking for a missing destination before renaming is not atomic.
        // Preserve the backup until it can be restored without overwriting a
        // destination created concurrently by another process or SFTP client.
        return Err(recovery());
    }
    if file_length(temp, sftp).await?.is_some() {
        cleanup_partial(temp, sftp, identity).await?;
    }
    Ok(())
}

async fn cleanup_partial(
    temp: &Endpoint,
    sftp: Option<&SftpSession>,
    _identity: Option<&FileIdentity>,
) -> AppResult<()> {
    #[cfg(windows)]
    if sftp.is_none() {
        let unrecognized = || AppError::TransferArtifactUnrecognized {
            path: temp.path.clone(),
        };
        let expected = _identity.ok_or_else(unrecognized)?;
        let guard =
            match crate::platform::guarded_file::GuardedFile::deletable(Path::new(&temp.path)) {
                Ok(guard) => guard,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
                Err(error) => return Err(error.into()),
            };
        if guard.identity()? != *expected {
            return Err(unrecognized());
        }
        // The verified object stays locked through deletion; a second path
        // lookup after checking its identity would reintroduce the race.
        guard.delete()?;
        return Ok(());
    }
    remove_transfer_file(temp, sftp).await
}

/// No source or completed destination is removed. Keep the journal on error so
/// a disconnected host can be reconnected and cleanup can be retried.
pub(super) async fn cleanup(
    app: &AppHandle,
    row: &durable::DurableTransfer,
    to: &Endpoint,
) -> AppResult<()> {
    let targets = recorded_paths(app, &row.id)?;
    // A completed job with no checkpoint predates staging and needs no network.
    if row.status == "done" && targets.is_empty() {
        return Ok(());
    }
    let sftp = match &to.session {
        Some(id) => Some(session(app, id).await?),
        None => None,
    };
    let result = async {
        for path in &targets {
            cleanup_file(app, &row.id, &to.child(path.clone()), sftp.as_ref()).await?;
        }
        // Support jobs created before explicit artifact records. Only inspect
        // their destination tree and remove names matching a saved file key.
        if targets.is_empty() {
            cleanup_file(app, &row.id, to, sftp.as_ref()).await?;
        }
        let directory = match sftp.as_ref() {
            Some(s) => match s.symlink_metadata(&to.path).await {
                Ok(m) => m.is_dir() && !m.is_symlink(),
                Err(russh_sftp::client::error::Error::Status(st))
                    if st.status_code == StatusCode::NoSuchFile =>
                {
                    false
                }
                Err(e) => return Err(map_sftp(e)),
            },
            None => match tokio::fs::symlink_metadata(&to.path).await {
                Ok(m) => m.is_dir() && !local_metadata_is_link(&m),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
                Err(e) => return Err(e.into()),
            },
        };
        if targets.is_empty() && directory {
            cleanup_legacy_tree(app, &row.id, to, sftp.as_ref()).await?;
        }
        Ok(())
    }
    .await;
    if let Some(sftp) = sftp {
        let _ = tokio::time::timeout(std::time::Duration::from_secs(5), sftp.close()).await;
    }
    result
}

async fn cleanup_legacy_tree(
    app: &AppHandle,
    id: &str,
    root: &Endpoint,
    sftp: Option<&SftpSession>,
) -> AppResult<()> {
    let prefixes: Vec<String> = app.state::<AppState>().db.with(|conn| {
        let mut query = conn.prepare("SELECT key FROM settings WHERE instr(key,?1)=1")?;
        let keys = query.query_map([format!("transfer-file:{id}:")], |r| r.get::<_, String>(0))?;
        let mut result = Vec::new();
        for key in keys {
            let key = key?;
            if let Some(digest) = key
                .rsplit(':')
                .next()
                .filter(|v| v.len() == 64 && v.bytes().all(|b| b.is_ascii_hexdigit()))
            {
                result.push(format!(".tunnelde-{id}-{}", &digest[..16]));
            }
        }
        Ok(result)
    })?;
    let mut pending = vec![root.clone()];
    while let Some(folder) = pending.pop() {
        for path in children(&folder, sftp).await? {
            let entry = folder.child(path);
            match is_dir(&entry, sftp).await {
                Ok(true) => pending.push(entry),
                Ok(false) => {
                    let name = file_name_of(&entry.path);
                    if prefixes
                        .iter()
                        .any(|prefix| name == format!("{prefix}.part"))
                    {
                        // Older Windows journals do not identify the original
                        // object. Preserve it and expose its exact location.
                        cleanup_partial(&entry, sftp, None).await?;
                    } else if prefixes
                        .iter()
                        .any(|prefix| name == format!("{prefix}.backup"))
                    {
                        // Legacy directory records do not identify the original
                        // filename. Preserve its backup and the recovery record.
                        return Err(AppError::validation("sftp.backupRecoveryRequired"));
                    }
                }
                Err(AppError::Validation(message)) if message == "sftp.symlinkUnsupported" => {}
                Err(error) => return Err(error),
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn local_identity(path: &str) -> Option<FileIdentity> {
        #[cfg(windows)]
        {
            Some(
                crate::platform::guarded_file::identity(&std::fs::File::open(path).unwrap())
                    .unwrap(),
            )
        }
        #[cfg(not(windows))]
        {
            let _ = path;
            None
        }
    }

    #[test]
    fn artifact_records_preserve_legacy_paths_and_round_trip_full_file_ids() {
        let legacy: ArtifactRecord = serde_json::from_str(r#""/older/destination""#).unwrap();
        assert!(legacy.identity().is_none());
        assert_eq!(legacy.into_path(), "/older/destination");
        let id = FileIdentity::Windows {
            volume: u64::MAX,
            index: [255; 16],
            created: u64::MAX,
        };
        let record = ArtifactRecord::Current {
            path: "/destination".into(),
            identity: Some(id.clone()),
            archive: None,
            publication: None,
        };
        let restored: ArtifactRecord =
            serde_json::from_str(&serde_json::to_string(&record).unwrap()).unwrap();
        assert_eq!(restored.identity(), Some(&id));
        assert_eq!(restored.into_path(), "/destination");
        assert!(
            serde_json::from_str::<ArtifactRecord>(r#"{"path":"/destination"}"#)
                .unwrap()
                .identity()
                .is_none()
        );
    }

    #[test]
    fn archive_generations_round_trip_and_never_reuse_retired_paths() {
        let to = Endpoint {
            session: Some("remote".into()),
            path: "/home/test/文件.bin".into(),
        };
        let legacy: ArtifactRecord =
            serde_json::from_str(r#"{"path":"/home/test/文件.bin","identity":null}"#).unwrap();
        let first = part_from_record(&to, "task", Some(&legacy)).unwrap();
        assert_eq!(first.path, staging_endpoint(&to, "task", "part").path);
        let mut paths = std::collections::HashSet::from([first.path]);
        for _ in 0..20 {
            let record = ArtifactRecord::Current {
                path: to.path.clone(),
                identity: None,
                archive: Some(ArchiveWrite {
                    generation: Some(uuid::Uuid::new_v4().to_string()),
                    pending: true,
                }),
                publication: None,
            };
            let restored: ArtifactRecord =
                serde_json::from_str(&serde_json::to_string(&record).unwrap()).unwrap();
            let part = part_from_record(&to, "task", Some(&restored)).unwrap();
            assert!(part.path.starts_with("/home/test/.tunnelde-task-"));
            assert!(part.path.ends_with(".part"));
            assert!(paths.insert(part.path));
            assert!(matches!(
                restored,
                ArtifactRecord::Current {
                    archive: Some(ArchiveWrite { pending: true, .. }),
                    ..
                }
            ));
        }
        let invalid = ArtifactRecord::Current {
            path: to.path.clone(),
            identity: None,
            archive: Some(ArchiveWrite {
                generation: Some("../other".into()),
                pending: true,
            }),
            publication: None,
        };
        assert!(part_from_record(&to, "task", Some(&invalid)).is_err());
    }

    #[test]
    fn publication_recovery_keeps_both_generations_until_confirmation() {
        let to = Endpoint {
            session: Some("remote".into()),
            path: "/home/test/文件.bin".into(),
        };
        let previous = uuid::Uuid::new_v4().to_string();
        let successor = uuid::Uuid::new_v4().to_string();
        let mut record: ArtifactRecord = serde_json::from_value(serde_json::json!({
            "path": to.path,
            "identity": null,
            "archive": { "generation": previous, "pending": false },
            "publication": { "successor": successor }
        }))
        .unwrap();
        // A crash before recording a successful fence must find both paths;
        // retrying uses the same successor, not a third staging generation.
        for _ in 0..3 {
            let restored: ArtifactRecord =
                serde_json::from_str(&serde_json::to_string(&record).unwrap()).unwrap();
            assert_eq!(
                part_from_record(&to, "task", Some(&restored)).unwrap().path,
                publication_successor(&to, "task", &previous).unwrap().path
            );
            let ArtifactRecord::Current {
                publication: Some(publication),
                ..
            } = &restored
            else {
                panic!("Lost publication uncertainty after restart");
            };
            assert_eq!(publication.successor.as_deref(), Some(successor.as_str()));
            assert_ne!(
                part_from_record(&to, "task", Some(&restored)).unwrap().path,
                publication_successor(&to, "task", &successor).unwrap().path
            );
            record = restored;
        }
        assert!(publication_successor(&to, "task", "../other").is_err());
        let initial: ArtifactRecord =
            serde_json::from_str(r#"{"path":"/target","identity":null,"publication":{}}"#).unwrap();
        assert!(matches!(
            initial,
            ArtifactRecord::Current {
                publication: Some(Publication { successor: None }),
                ..
            }
        ));
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn replacement_with_identical_bytes_is_never_resumed_or_deleted() {
        let root = std::env::temp_dir().join(format!(
            "tunnelde-cleanup-identity-{}",
            uuid::Uuid::new_v4()
        ));
        tokio::fs::create_dir(&root).await.unwrap();
        let target = Endpoint {
            session: None,
            path: display_path(&root.join("target")),
        };
        let part = staging_endpoint(&target, "job", "part");
        tokio::fs::write(&part.path, b"same contents")
            .await
            .unwrap();
        let expected = local_identity(&part.path).unwrap();
        let original = root.join("original");
        tokio::fs::rename(&part.path, &original).await.unwrap();
        tokio::fs::write(&part.path, b"same contents")
            .await
            .unwrap();
        assert_ne!(local_identity(&part.path).as_ref(), Some(&expected));
        for error in [
            pin_partial(&part, Some(&expected)).err().unwrap(),
            cleanup_owned("job", &target, None, None, Some(&expected))
                .await
                .unwrap_err(),
        ] {
            assert!(
                matches!(error, AppError::TransferArtifactUnrecognized { ref path } if path == &part.path)
            );
        }
        assert_eq!(tokio::fs::read(&part.path).await.unwrap(), b"same contents");
        assert_eq!(tokio::fs::read(&original).await.unwrap(), b"same contents");
        // A legacy record is also insufficient, even with matching bytes.
        assert!(pin_partial(&part, None).is_err());
        assert!(
            matches!(cleanup_owned("job", &target, None, None, None).await.unwrap_err(),
            AppError::TransferArtifactUnrecognized { ref path } if path == &part.path)
        );
        tokio::fs::remove_file(&part.path).await.unwrap();
        // Manual inspection/removal leaves the task's cleanup safely retryable.
        assert!(pin_partial(&part, Some(&expected)).unwrap().is_none());
        cleanup_owned("job", &target, None, None, None)
            .await
            .unwrap();
        tokio::fs::remove_file(original).await.unwrap();
        tokio::fs::remove_dir(root).await.unwrap();
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn active_writers_prevent_cleanup_and_pins_allow_checkpoint_trimming() {
        let root =
            std::env::temp_dir().join(format!("tunnelde-cleanup-writer-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir(&root).await.unwrap();
        let target = Endpoint {
            session: None,
            path: display_path(&root.join("target")),
        };
        let part = staging_endpoint(&target, "job", "part");
        let writer = open_writer(&part, None, false).await.unwrap();
        let Writer::Local(file) = &writer else {
            unreachable!()
        };
        let expected = crate::platform::guarded_file::identity(file).unwrap();
        file.set_len(16).await.unwrap();
        assert!(cleanup_owned("job", &target, None, None, Some(&expected))
            .await
            .is_err());
        let pin = pin_partial(&part, Some(&expected)).unwrap().unwrap();
        segments::resize(&part, None, 4).await.unwrap();
        assert_eq!(file_length(&part, None).await.unwrap(), Some(4));
        assert_eq!(pin.identity().unwrap(), expected);
        assert!(tokio::fs::remove_file(&part.path).await.is_err());
        writer.finish().await.unwrap();
        assert!(cleanup_owned("job", &target, None, None, Some(&expected))
            .await
            .is_err());
        drop(pin);
        cleanup_owned("job", &target, None, None, Some(&expected))
            .await
            .unwrap();
        assert!(!Path::new(&part.path).exists());
        tokio::fs::remove_dir(root).await.unwrap();
    }

    #[tokio::test]
    async fn interrupted_parallel_windows_trim_only_uncommitted_bytes_and_reject_changed_sources() {
        let root = std::env::temp_dir().join(format!("tunnelde-window-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir(&root).await.unwrap();
        let target = Endpoint {
            session: None,
            path: display_path(&root.join("owned.part")),
        };
        tokio::fs::write(&target.path, b"safeSPARSE UNCOMMITTED DATA")
            .await
            .unwrap();
        let source = (1024, Some(123));
        let before = tokio::fs::read(&target.path).await.unwrap();
        assert_eq!(
            restore_window_prefix(
                ParallelCheckpoint { source, offset: 4 },
                source,
                &target,
                None,
                Some(&AtomicBool::new(true)),
            )
            .await
            .unwrap_err()
            .to_string(),
            CANCELLED
        );
        assert_eq!(tokio::fs::read(&target.path).await.unwrap(), before);
        restore_window_prefix(
            ParallelCheckpoint { source, offset: 4 },
            source,
            &target,
            None,
            None,
        )
        .await
        .unwrap();
        assert_eq!(tokio::fs::read(&target.path).await.unwrap(), b"safe");
        assert!(restore_window_prefix(
            ParallelCheckpoint { source, offset: 4 },
            (1024, Some(124)),
            &target,
            None,
            None
        )
        .await
        .is_err());
        assert!(restore_window_prefix(
            ParallelCheckpoint { source, offset: 5 },
            source,
            &target,
            None,
            None
        )
        .await
        .is_err());
        assert_eq!(tokio::fs::read(&target.path).await.unwrap(), b"safe");
        tokio::fs::remove_dir_all(root).await.unwrap();
    }

    #[tokio::test]
    async fn transfer_artifact_cleanup_preserves_a_partial_path_replaced_with_a_directory() {
        let root =
            std::env::temp_dir().join(format!("tunnelde-cleanup-dir-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir(&root).await.unwrap();
        let target = Endpoint {
            session: None,
            path: display_path(&root.join("target")),
        };
        let part = staging_endpoint(&target, "job", "part");
        tokio::fs::create_dir(&part.path).await.unwrap();
        let independent = Path::new(&part.path).join("independent.txt");
        tokio::fs::write(&independent, b"preserve").await.unwrap();
        assert!(cleanup_owned("job", &target, None, None, None)
            .await
            .is_err());
        assert_eq!(tokio::fs::read(&independent).await.unwrap(), b"preserve");
        tokio::fs::remove_file(independent).await.unwrap();
        tokio::fs::remove_dir(&part.path).await.unwrap();
        tokio::fs::remove_dir(root).await.unwrap();
    }

    #[tokio::test]
    async fn cleanup_removes_partial_files_and_preserves_backups_for_recovery() {
        let root = std::env::temp_dir().join(format!("tunnelde-cleanup-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir(&root).await.unwrap();
        let target = Endpoint {
            session: None,
            path: display_path(&root.join("target")),
        };
        let part = staging_endpoint(&target, "job", "part");
        let backup = staging_endpoint(&target, "job", "backup");
        let unrelated = target.child(display_path(&root.join(".tunnelde-another.part")));
        tokio::fs::write(&target.path, b"user data").await.unwrap();
        tokio::fs::write(&part.path, b"partial").await.unwrap();
        tokio::fs::write(&unrelated.path, b"other job")
            .await
            .unwrap();
        let identity = local_identity(&part.path);
        cleanup_owned("job", &target, None, None, identity.as_ref())
            .await
            .unwrap();
        assert!(!Path::new(&part.path).exists());
        assert_eq!(tokio::fs::read(&target.path).await.unwrap(), b"user data");
        assert!(Path::new(&unrelated.path).exists());

        let expected = fingerprint_file(&target, None, &AtomicBool::new(false))
            .await
            .unwrap();
        tokio::fs::rename(&target.path, &backup.path).await.unwrap();
        tokio::fs::write(&part.path, b"partial").await.unwrap();
        let error = cleanup_owned("job", &target, None, Some(&expected), None)
            .await
            .unwrap_err();
        assert!(matches!(
            error,
            AppError::BackupRecovery { ref backup, ref destination }
                if backup == &staging_endpoint(&target, "job", "backup").path
                    && destination == &target.path
        ));
        assert!(!Path::new(&target.path).exists());
        assert_eq!(tokio::fs::read(&backup.path).await.unwrap(), b"user data");
        assert_eq!(tokio::fs::read(&part.path).await.unwrap(), b"partial");

        tokio::fs::write(&target.path, b"new independent data")
            .await
            .unwrap();
        tokio::fs::write(&part.path, b"partial").await.unwrap();
        assert_eq!(
            cleanup_owned("job", &target, None, Some(&expected), None)
                .await
                .unwrap_err()
                .to_string(),
            "sftp.backupRecoveryRequired"
        );
        assert_eq!(tokio::fs::read(&backup.path).await.unwrap(), b"user data");
        assert_eq!(
            tokio::fs::read(&target.path).await.unwrap(),
            b"new independent data"
        );
        assert_eq!(tokio::fs::read(&part.path).await.unwrap(), b"partial");
        tokio::fs::remove_file(&target.path).await.unwrap();
        tokio::fs::rename(&backup.path, &target.path).await.unwrap();

        tokio::fs::write(&backup.path, b"unrecognized data")
            .await
            .unwrap();
        tokio::fs::write(&part.path, b"partial").await.unwrap();
        let error = cleanup_owned("job", &target, None, Some(&expected), None)
            .await
            .unwrap_err();
        assert!(matches!(
            error,
            AppError::BackupUnrecognized { ref backup, ref destination }
                if backup == &staging_endpoint(&target, "job", "backup").path
                    && destination == &target.path
        ));
        let error = cleanup_owned("job", &target, None, None, None)
            .await
            .unwrap_err();
        assert!(matches!(error, AppError::BackupUnrecognized { .. }));
        assert!(Path::new(&backup.path).exists());
        assert!(Path::new(&part.path).exists());
        assert_eq!(tokio::fs::read(&target.path).await.unwrap(), b"user data");
        tokio::fs::remove_dir_all(root).await.unwrap();
    }

    #[tokio::test]
    async fn checkpoint_resume_reads_boundaries_and_positions_at_the_real_offset() {
        let root = std::env::temp_dir().join(format!("tunnelde-resume-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir(&root).await.unwrap();
        let source = Endpoint {
            session: None,
            path: display_path(&root.join("source")),
        };
        let temp = source.child(display_path(&root.join("partial")));
        let data: Vec<u8> = (0..CHUNK * 5 + 13).map(|i| (i % 251) as u8).collect();
        tokio::fs::write(&source.path, &data).await.unwrap();
        let existing = (CHUNK * 4 + 3) as u64;
        tokio::fs::write(&temp.path, &data[..existing as usize])
            .await
            .unwrap();
        let mut reader = open_reader(&source, None).await.unwrap();
        let cancel = AtomicBool::new(false);
        verify_resume(&mut reader, &temp, None, existing, true, &cancel)
            .await
            .unwrap();
        let mut next = [0; 10];
        reader.read(&mut next).await.unwrap();
        assert_eq!(next, data[existing as usize..existing as usize + 10]);
        let mut changed = data[..existing as usize].to_vec();
        changed[CHUNK * 2] ^= 1;
        tokio::fs::write(&temp.path, changed).await.unwrap();
        assert!(
            verify_resume(&mut reader, &temp, None, existing, false, &cancel)
                .await
                .is_err()
        );
        reader.finish().await.unwrap();
        tokio::fs::remove_dir_all(root).await.unwrap();
    }

    #[tokio::test]
    async fn pending_socket_operations_can_be_cancelled() {
        let flag = Arc::new(AtomicBool::new(false));
        let worker_flag = flag.clone();
        let task = tokio::spawn(async move {
            interruptible(Some(&worker_flag), std::future::pending::<AppResult<()>>()).await
        });
        flag.store(true, Ordering::SeqCst);
        let result = tokio::time::timeout(std::time::Duration::from_millis(250), task)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(result.unwrap_err().to_string(), CANCELLED);
    }
}
