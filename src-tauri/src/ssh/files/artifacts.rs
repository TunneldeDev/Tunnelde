use super::*;
use crate::platform::file_identity::FileIdentity;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

mod protection;
pub(super) mod retained;
mod staging;
#[cfg(test)]
mod test_support;
pub(super) use staging::create_directory;
use staging::{prepare_remote_staging, remote_staging, retire_remote_staging, staging_directory};

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
        #[serde(default, skip_serializing_if = "Option::is_none")]
        staging: Option<RemoteStaging>,
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

/// An acknowledged private directory fences a delayed CREATE: after removing
/// this directory, an old OPEN cannot recreate its child on a resumed task.
#[derive(Serialize, Deserialize)]
struct RemoteStaging {
    generation: String,
    prepared: bool,
    opening: bool,
    // Older unprepared journals cannot prove whether MKDIR was sent.
    #[serde(default = "staging::unacknowledged_creation")]
    creating: bool,
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
    let part = staging_endpoint(to, &owner, "part");
    match record {
        Some(ArtifactRecord::Current {
            staging: Some(staging),
            ..
        }) => {
            let directory = staging_directory(to, id, staging)?;
            Ok(to.child(join_remote(&directory.path, &file_name_of(&part.path))))
        }
        _ => Ok(part),
    }
}

pub(super) fn creation_pending(
    app: &AppHandle,
    id: &str,
    to: &Endpoint,
    pending: bool,
) -> AppResult<bool> {
    let Some(mut record) = artifact_record(app, id, to)? else {
        return Ok(false);
    };
    let ArtifactRecord::Current {
        staging: Some(staging),
        ..
    } = &mut record
    else {
        return Ok(false);
    };
    if !staging.prepared {
        return Err(AppError::internal("Staging directory not acknowledged"));
    }
    staging.opening = pending;
    put(app, &artifact_key(id, to), serde_json::to_string(&record)?)?;
    Ok(true)
}

/// Called only after publication is saved. A failed or interrupted RMDIR leaves
/// the completed-file checkpoint so Resume verifies the target and retries it.
pub(super) async fn finish_staging(
    app: &AppHandle,
    id: &str,
    to: &Endpoint,
    metadata: Option<&Arc<SftpSession>>,
    cancel: &AtomicBool,
    observation: &native_save::runtime::MutationObservation,
) -> AppResult<()> {
    let record = artifact_record(app, id, to)?;
    let Some(staging) = remote_staging(record.as_ref()) else {
        return Ok(());
    };
    let metadata = metadata.ok_or_else(|| AppError::internal("Missing staging cleanup session"))?;
    let sftp = metadata.as_ref();
    let directory = staging_directory(to, id, staging)?;
    if let Some(session_id) = &to.session {
        transfer_ownership::writable(app, id, session_id, sftp, &[&directory.path]).await?;
    }
    interruptible(
        Some(cancel),
        staging::cleanup_directory(
            metadata,
            &directory,
            !staging.prepared && staging.creating,
            observation,
        ),
    )
    .await
}

/// Retire an uncertain archive before making another writer. The worker only
/// opens existing files: a delayed open now fails, and an already-open writer
/// can only touch the unlinked old inode. The next generation has a fresh path.
pub(super) async fn prepare_staging<F, Fut>(
    app: &AppHandle,
    id: &str,
    to: &Endpoint,
    metadata: Option<&Arc<SftpSession>>,
    cancel: &AtomicBool,
    observation: &native_save::runtime::MutationObservation,
    create_directory: F,
) -> AppResult<(Endpoint, bool)>
where
    F: FnOnce(Endpoint) -> Fut,
    Fut: std::future::Future<Output = AppResult<()>>,
{
    let sftp = metadata.map(Arc::as_ref);
    let mut record = artifact_record(app, id, to)?;
    protection::writable(app, id, to, sftp, record.as_ref()).await?;
    prepare_remote_staging(
        app,
        id,
        to,
        metadata,
        cancel,
        &mut record,
        staging::Preparation {
            observation,
            create_directory,
        },
    )
    .await?;
    let temp = part_from_record(to, id, record.as_ref())?;
    let recovering_publication = matches!(
        record,
        Some(ArtifactRecord::Current {
            publication: Some(_),
            ..
        })
    );
    if recovering_publication {
        let metadata =
            metadata.ok_or_else(|| AppError::internal("Remote publication on local staging"))?;
        let sftp = metadata.as_ref();
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
        let next = publication_successor(to, id, &successor, record.as_ref())?;
        protection::writable(app, id, to, Some(sftp), record.as_ref()).await?;
        if !publication::fence(&temp, &next, metadata, cancel, observation).await? {
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
                interruptible(
                    Some(cancel),
                    remove_transfer_file(&temp, metadata, observation),
                )
                .await?;
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
            protection::writable(app, id, to, sftp, record.as_ref()).await?;
            return Ok((part_from_record(to, id, record.as_ref())?, false));
        }
    }
    Ok((temp, false))
}

fn publication_successor(
    to: &Endpoint,
    id: &str,
    generation: &str,
    record: Option<&ArtifactRecord>,
) -> AppResult<Endpoint> {
    let generation = uuid::Uuid::parse_str(generation)
        .map_err(|_| AppError::internal("Invalid publication staging generation"))?;
    let part = staging_endpoint(to, &format!("{id}-{generation}"), "part");
    match record {
        Some(ArtifactRecord::Current {
            staging: Some(staging),
            ..
        }) => {
            let directory = staging_directory(to, id, staging)?;
            Ok(to.child(join_remote(&directory.path, &file_name_of(&part.path))))
        }
        _ => Ok(part),
    }
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
                staging: None,
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
struct ParallelCheckpoint {
    source: (u64, Option<i64>),
    offset: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    end: Option<u64>,
}

pub(super) fn begin_window(
    app: &AppHandle,
    key: &str,
    source: (u64, Option<i64>),
    window: std::ops::Range<u64>,
) -> AppResult<()> {
    put(
        app,
        &key.replacen("transfer-file:", "transfer-parallel:", 1),
        serde_json::to_string(&ParallelCheckpoint {
            source,
            offset: window.start,
            end: Some(window.end),
        })?,
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
) -> AppResult<Option<std::ops::Range<u64>>> {
    let marker = get(
        app,
        &key.replacen("transfer-file:", "transfer-parallel:", 1),
    )?;
    let Some(marker) = marker else {
        return Ok(None);
    };
    let checkpoint: ParallelCheckpoint = serde_json::from_str(&marker)?;
    // Retain this marker through verification and the first replay. A crash or
    // another pause must never promote the old sparse tail to a valid prefix.
    restore_window_prefix(checkpoint, source, temp, sftp, cancel)
        .await
        .map(Some)
}

async fn restore_window_prefix(
    checkpoint: ParallelCheckpoint,
    source: (u64, Option<i64>),
    temp: &Endpoint,
    sftp: Option<&SftpSession>,
    cancel: Option<&AtomicBool>,
) -> AppResult<std::ops::Range<u64>> {
    if checkpoint.source != source
        || checkpoint.offset > source.0
        || checkpoint
            .end
            .is_some_and(|end| end < checkpoint.offset || end > source.0)
    {
        return Err(AppError::validation("sftp.resumeSourceChanged"));
    }
    let length = interruptible(cancel, file_length(temp, sftp))
        .await?
        .unwrap_or(0);
    if length < checkpoint.offset
        || length > source.0
        || checkpoint.end.is_some_and(|end| length > end)
    {
        return Err(AppError::validation("sftp.resumePrefixMismatch"));
    }
    // Only bytes before offset are eligible for verification/resume. Rewrite
    // the entire old window instead of truncating it: SETSTAT can stall and a
    // late truncate could destroy bytes acknowledged by a later resume.
    // Legacy markers did not record the submitted end. Conservatively replay
    // the remaining source: a delayed WRITE can extend the observed length.
    Ok(checkpoint.offset..checkpoint.end.unwrap_or(source.0))
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

pub(super) fn record(app: &AppHandle, id: &str, to: &Endpoint, fresh: bool) -> AppResult<()> {
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
            staging: to
                .session
                .as_ref()
                .filter(|_| fresh)
                .map(|_| RemoteStaging {
                    generation: uuid::Uuid::new_v4().to_string(),
                    prepared: false,
                    opening: false,
                    creating: false,
                }),
        })?,
    )
}

pub(super) async fn validate_partial_length(
    temp: &Endpoint,
    sftp: Option<&SftpSession>,
    submitted: std::ops::RangeInclusive<u64>,
) -> AppResult<()> {
    if !file_length(temp, sftp)
        .await?
        .is_some_and(|length| submitted.contains(&length))
    {
        return Err(AppError::validation("sftp.resumePrefixMismatch"));
    }
    Ok(())
}

pub(super) async fn resume_offset(
    reader: &mut Reader,
    temp: &Endpoint,
    sftp: Option<&SftpSession>,
    existing: u64,
    cancel: &AtomicBool,
) -> AppResult<()> {
    // Size and mtime (including legacy transfer-part checkpoints) cannot prove
    // that the middle of either file is unchanged. Verify every retained byte;
    // success leaves the source reader exactly at the continuation offset.
    verify_prefix(reader, temp, sftp, existing, Some(cancel)).await
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
    metadata: Option<&Arc<SftpSession>>,
    observation: &native_save::runtime::MutationObservation,
) -> AppResult<()> {
    let sftp = metadata.map(Arc::as_ref);
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
    protection::writable(app, id, to, sftp, artifact.as_ref()).await?;
    staging::require_creation_settled(id, to, artifact.as_ref())?;
    if remote_staging(artifact.as_ref()).is_some_and(|staging| staging.opening) {
        return retire_remote_staging(
            id,
            to,
            metadata.ok_or_else(|| AppError::internal("Missing staging cleanup session"))?,
            artifact.as_ref().unwrap(),
            &AtomicBool::new(false),
            observation,
        )
        .await;
    }
    let temp = part_from_record(to, id, artifact.as_ref())?;
    cleanup_at(
        id,
        to,
        &temp,
        metadata,
        backup_checkpoint(app, &key)?.as_ref(),
        artifact.as_ref().and_then(ArtifactRecord::identity),
        observation,
    )
    .await?;
    if let Some(ArtifactRecord::Current {
        publication: Some(Publication {
            successor: Some(generation),
        }),
        ..
    }) = artifact.as_ref()
    {
        let next = publication_successor(to, id, generation, artifact.as_ref())?;
        if file_length(&next, sftp).await?.is_some() {
            cleanup_partial(&next, metadata, None, observation).await?;
        }
    }
    finish_staging(app, id, to, metadata, &AtomicBool::new(false), observation).await?;
    Ok(())
}

#[cfg(test)]
pub(super) async fn cleanup_owned(
    id: &str,
    to: &Endpoint,
    metadata: Option<&Arc<SftpSession>>,
    expected: Option<&BackupFingerprint>,
    identity: Option<&FileIdentity>,
) -> AppResult<()> {
    let temp = staging_endpoint(to, id, "part");
    cleanup_at(
        id,
        to,
        &temp,
        metadata,
        expected,
        identity,
        &native_save::runtime::MutationObservation::default(),
    )
    .await
}

async fn cleanup_at(
    id: &str,
    to: &Endpoint,
    temp: &Endpoint,
    metadata: Option<&Arc<SftpSession>>,
    expected: Option<&BackupFingerprint>,
    identity: Option<&FileIdentity>,
    observation: &native_save::runtime::MutationObservation,
) -> AppResult<()> {
    let sftp = metadata.map(Arc::as_ref);
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
        cleanup_partial(temp, metadata, identity, observation).await?;
    }
    Ok(())
}

async fn cleanup_partial(
    temp: &Endpoint,
    metadata: Option<&Arc<SftpSession>>,
    _identity: Option<&FileIdentity>,
    observation: &native_save::runtime::MutationObservation,
) -> AppResult<()> {
    #[cfg(windows)]
    if metadata.is_none() {
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
        observation.authorize()?;
        guard.delete()?;
        return Ok(());
    }
    remove_transfer_file(temp, metadata, observation).await
}

/// No source or completed destination is removed. Keep the journal on error so
/// a disconnected host can be reconnected and cleanup can be retried.
pub(super) async fn cleanup(
    app: &AppHandle,
    row: &durable::DurableTransfer,
    to: &Endpoint,
    observation: &native_save::runtime::MutationObservation,
) -> AppResult<()> {
    let targets = recorded_paths(app, &row.id)?;
    // A completed job with no checkpoint predates staging and needs no network.
    if row.status == "done" && targets.is_empty() {
        return Ok(());
    }
    let metadata = match &to.session {
        Some(id) => Some(Arc::new(session(app, id).await?)),
        None => None,
    };
    let sftp = metadata.as_deref();
    let result = async {
        if let (Some(session_id), Some(sftp)) = (to.session.as_deref(), sftp) {
            transfer_ownership::writable(app, &row.id, session_id, sftp, &[&to.path]).await?;
            for path in &targets {
                transfer_ownership::writable(app, &row.id, session_id, sftp, &[path]).await?;
            }
        }
        for path in &targets {
            cleanup_file(
                app,
                &row.id,
                &to.child(path.clone()),
                metadata.as_ref(),
                observation,
            )
            .await?;
        }
        // Support jobs created before explicit artifact records. Only inspect
        // their destination tree and remove names matching a saved file key.
        if targets.is_empty() {
            cleanup_file(app, &row.id, to, metadata.as_ref(), observation).await?;
        }
        let directory = match sftp {
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
            cleanup_legacy_tree(app, &row.id, to, metadata.as_ref(), observation).await?;
        }
        Ok(())
    }
    .await;
    if let Some(metadata) = metadata {
        metadata::close(metadata).await;
    }
    result
}

async fn cleanup_legacy_tree(
    app: &AppHandle,
    id: &str,
    root: &Endpoint,
    metadata: Option<&Arc<SftpSession>>,
    observation: &native_save::runtime::MutationObservation,
) -> AppResult<()> {
    let sftp = metadata.map(Arc::as_ref);
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
                        cleanup_partial(&entry, metadata, None, observation).await?;
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
            staging: None,
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
                staging: None,
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
            staging: None,
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
                publication_successor(&to, "task", &previous, Some(&restored))
                    .unwrap()
                    .path
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
                publication_successor(&to, "task", &successor, Some(&restored))
                    .unwrap()
                    .path
            );
            record = restored;
        }
        assert!(publication_successor(&to, "task", "../other", None).is_err());
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
    async fn active_writers_and_pins_prevent_cleanup_until_their_handles_close() {
        let root =
            std::env::temp_dir().join(format!("tunnelde-cleanup-writer-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir(&root).await.unwrap();
        let target = Endpoint {
            session: None,
            path: display_path(&root.join("target")),
        };
        let part = staging_endpoint(&target, "job", "part");
        let writer = open_writer(&part, None, false, &Default::default())
            .await
            .unwrap();
        let Writer::Local(file) = &writer else {
            unreachable!()
        };
        let expected = crate::platform::guarded_file::identity(file).unwrap();
        file.set_len(16).await.unwrap();
        assert!(cleanup_owned("job", &target, None, None, Some(&expected))
            .await
            .is_err());
        let pin = pin_partial(&part, Some(&expected)).unwrap().unwrap();
        assert_eq!(file_length(&part, None).await.unwrap(), Some(16));
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
    async fn interrupted_parallel_windows_preserve_the_tail_and_reject_changed_sources() {
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
                ParallelCheckpoint {
                    source,
                    offset: 4,
                    end: Some(128)
                },
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
        let replay = restore_window_prefix(
            ParallelCheckpoint {
                source,
                offset: 4,
                end: Some(128),
            },
            source,
            &target,
            None,
            None,
        )
        .await
        .unwrap();
        assert_eq!(replay, 4..128);
        assert_eq!(tokio::fs::read(&target.path).await.unwrap(), before);
        assert!(restore_window_prefix(
            ParallelCheckpoint {
                source,
                offset: 4,
                end: Some(128)
            },
            (1024, Some(124)),
            &target,
            None,
            None
        )
        .await
        .is_err());
        assert!(restore_window_prefix(
            ParallelCheckpoint {
                source,
                offset: before.len() as u64 + 1,
                end: Some(128)
            },
            source,
            &target,
            None,
            None
        )
        .await
        .is_err());
        assert_eq!(tokio::fs::read(&target.path).await.unwrap(), before);
        tokio::fs::remove_dir_all(root).await.unwrap();
    }

    #[tokio::test]
    async fn recovery_rejects_invalid_extents_and_never_mutates_the_staging_file() {
        let root =
            std::env::temp_dir().join(format!("tunnelde-window-bounds-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir(&root).await.unwrap();
        let target = Endpoint {
            session: None,
            path: display_path(&root.join("owned.part")),
        };
        let bytes = b"safe-unconfirmed-tail";
        tokio::fs::write(&target.path, bytes).await.unwrap();
        let source = (64, Some(123));
        for (offset, end) in [
            (65, Some(65)),
            (4, Some(3)),
            (4, Some(65)),
            (4, Some(8)),
            (32, Some(64)),
        ] {
            assert!(restore_window_prefix(
                ParallelCheckpoint {
                    source,
                    offset,
                    end
                },
                source,
                &target,
                None,
                None
            )
            .await
            .is_err());
            assert_eq!(tokio::fs::read(&target.path).await.unwrap(), bytes);
        }
        let legacy: ParallelCheckpoint =
            serde_json::from_str(r#"{"source":[64,123],"offset":4}"#).unwrap();
        assert!(legacy.end.is_none());
        // An old unacknowledged write could arrive beyond the current length.
        assert_eq!(
            restore_window_prefix(legacy, source, &target, None, None)
                .await
                .unwrap(),
            4..64
        );
        assert_eq!(tokio::fs::read(&target.path).await.unwrap(), bytes);
        let small = (8, Some(123));
        assert!(restore_window_prefix(
            ParallelCheckpoint {
                source: small,
                offset: 4,
                end: None
            },
            small,
            &target,
            None,
            None
        )
        .await
        .is_err());
        tokio::fs::remove_file(&target.path).await.unwrap();
        assert_eq!(
            restore_window_prefix(
                ParallelCheckpoint {
                    source,
                    offset: 0,
                    end: Some(64)
                },
                source,
                &target,
                None,
                None
            )
            .await
            .unwrap(),
            0..64
        );
        assert!(restore_window_prefix(
            ParallelCheckpoint {
                source,
                offset: 4,
                end: Some(64)
            },
            source,
            &target,
            None,
            None
        )
        .await
        .is_err());
        tokio::fs::remove_dir(root).await.unwrap();
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
    async fn resume_rejects_middle_changes_with_preserved_metadata() {
        let root = std::env::temp_dir().join(format!("tunnelde-resume-{}", uuid::Uuid::new_v4()));
        tokio::fs::create_dir(&root).await.unwrap();
        let source = Endpoint {
            session: None,
            path: display_path(&root.join("source")),
        };
        let temp = source.child(display_path(&root.join("partial")));
        let data: Vec<u8> = (0..CHUNK * 5 + 13).map(|i| (i % 251) as u8).collect();
        let existing = (CHUNK * 4 + 3) as u64;
        let cancel = AtomicBool::new(false);
        let mut errors = Vec::new();
        for changed_source in [false, true] {
            tokio::fs::write(&source.path, &data).await.unwrap();
            tokio::fs::write(&temp.path, &data[..existing as usize])
                .await
                .unwrap();
            let changed = if changed_source { &source } else { &temp };
            let before = source_stamp(changed, None).await.unwrap();
            let modified = std::fs::metadata(&changed.path)
                .unwrap()
                .modified()
                .unwrap();
            let mut bytes = tokio::fs::read(&changed.path).await.unwrap();
            bytes[CHUNK * 2] ^= 1;
            tokio::fs::write(&changed.path, bytes).await.unwrap();
            std::fs::OpenOptions::new()
                .write(true)
                .open(&changed.path)
                .unwrap()
                .set_times(std::fs::FileTimes::new().set_modified(modified))
                .unwrap();
            assert_eq!(source_stamp(changed, None).await.unwrap(), before);
            let mut reader = open_reader(&source, None).await.unwrap();
            errors.push(
                resume_offset(&mut reader, &temp, None, existing, &cancel)
                    .await
                    .err()
                    .map(|error| error.to_string()),
            );
            reader.finish().await.unwrap();
        }
        tokio::fs::remove_dir_all(root).await.unwrap();
        assert_eq!(
            errors,
            vec![Some("sftp.resumePrefixMismatch".into()); 2],
            "Matching sizes and timestamps must not hide source or staging corruption",
        );
    }

    #[tokio::test]
    async fn resume_verifies_the_prefix_and_positions_at_the_real_offset() {
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
        resume_offset(&mut reader, &temp, None, existing, &cancel)
            .await
            .unwrap();
        let mut next = [0; 10];
        reader.read(&mut next).await.unwrap();
        assert_eq!(next, data[existing as usize..existing as usize + 10]);
        let mut changed = data[..existing as usize].to_vec();
        changed[CHUNK * 2] ^= 1;
        tokio::fs::write(&temp.path, changed).await.unwrap();
        assert!(resume_offset(&mut reader, &temp, None, existing, &cancel)
            .await
            .is_err());
        reader.finish().await.unwrap();
        tokio::fs::remove_dir_all(root).await.unwrap();
    }

    #[tokio::test]
    async fn already_cancelled_operations_are_never_polled() {
        let flag = AtomicBool::new(true);
        let polled = AtomicBool::new(false);
        let result = interruptible(Some(&flag), async {
            polled.store(true, Ordering::SeqCst);
            Ok(())
        })
        .await;
        assert_eq!(result.unwrap_err().to_string(), CANCELLED);
        assert!(!polled.load(Ordering::SeqCst));
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
