//! Task-owned remote staging directories fence delayed file creation.
use super::*;

pub(super) fn staging_directory(
    to: &Endpoint,
    id: &str,
    staging: &RemoteStaging,
) -> AppResult<Endpoint> {
    if to.session.is_none() {
        return Err(AppError::internal(
            "Remote staging directory on local transfer",
        ));
    }
    let generation = uuid::Uuid::parse_str(&staging.generation)
        .map_err(|_| AppError::internal("Invalid transfer staging directory generation"))?;
    Ok(staging_endpoint(to, &format!("{id}-{generation}"), "stage"))
}

pub(super) fn remote_staging(record: Option<&ArtifactRecord>) -> Option<&RemoteStaging> {
    match record {
        Some(ArtifactRecord::Current { staging, .. }) => staging.as_ref(),
        _ => None,
    }
}

pub(super) fn missing(error: &russh_sftp::client::error::Error) -> bool {
    matches!(error, russh_sftp::client::error::Error::Status(status)
        if status.status_code == StatusCode::NoSuchFile)
}

pub(super) async fn prepare_remote_staging<F, Fut>(
    app: &AppHandle,
    id: &str,
    to: &Endpoint,
    sftp: Option<&SftpSession>,
    cancel: &AtomicBool,
    record: &mut Option<ArtifactRecord>,
    create_directory: F,
) -> AppResult<()>
where
    F: FnOnce(Endpoint) -> Fut,
    Fut: std::future::Future<Output = AppResult<()>>,
{
    require_creation_settled(id, to, record.as_ref())?;
    let Some(staging) = remote_staging(record.as_ref()) else {
        return Ok(());
    };
    let sftp = sftp.ok_or_else(|| AppError::internal("Missing remote staging session"))?;
    if staging.opening {
        // Never reuse the parent of an OPEN whose reply was lost. An unlink of
        // the child alone would still allow a late CREATE to recreate it.
        retire_remote_staging(id, to, sftp, record.as_ref().unwrap(), cancel).await?;
        if let Some(ArtifactRecord::Current {
            staging: Some(staging),
            ..
        }) = record
        {
            *staging = RemoteStaging {
                generation: uuid::Uuid::new_v4().to_string(),
                prepared: false,
                opening: false,
                creating: false,
            };
        }
        put(
            app,
            &artifact_key(id, to),
            serde_json::to_string(&record.as_ref().unwrap())?,
        )?;
    }
    let staging = remote_staging(record.as_ref()).unwrap();
    if staging.prepared {
        return Ok(());
    }
    let directory = staging_directory(to, id, staging)?;
    ensure_private_directory(sftp, &directory, cancel, |directory| async {
        // The caller persists its creation intent only after channel setup and
        // immediately before submitting MKDIR. Do not mark connection failures
        // as uncertain mutations.
        create_directory(directory).await?;
        set_creating(app, id, to, record, false)
    })
    .await?;
    if let Some(ArtifactRecord::Current {
        staging: Some(staging),
        ..
    }) = record
    {
        staging.prepared = true;
    }
    put(
        app,
        &artifact_key(id, to),
        serde_json::to_string(&record.as_ref().unwrap())?,
    )
}

async fn ensure_private_directory<F, Fut>(
    sftp: &SftpSession,
    directory: &Endpoint,
    cancel: &AtomicBool,
    create_directory: F,
) -> AppResult<()>
where
    F: FnOnce(Endpoint) -> Fut,
    Fut: std::future::Future<Output = AppResult<()>>,
{
    match interruptible(Some(cancel), async {
        match sftp.symlink_metadata(&directory.path).await {
            Ok(metadata) => Ok(Some(metadata)),
            Err(error) if missing(&error) => Ok(None),
            Err(error) => Err(map_sftp(error)),
        }
    })
    .await?
    {
        Some(metadata) => {
            validate_directory(sftp, &directory.path, metadata, cancel, true).await?;
        }
        None => {
            // MKDIR still has to acknowledge: unlike OPEN, its parent is not
            // removable to fence a delayed directory creation. Keep its journal.
            create_directory(directory.clone()).await?;
            let metadata = interruptible(Some(cancel), async {
                sftp.symlink_metadata(&directory.path)
                    .await
                    .map_err(map_sftp)
            })
            .await?;
            // A successfully created directory is empty by definition. Listing
            // it adds OPEN/READ/CLOSE round trips to every small file. Only a
            // recovered, pre-existing directory needs the content check.
            validate_directory(sftp, &directory.path, metadata, cancel, false).await?;
        }
    }
    Ok(())
}

/// Validate an acknowledged or unsent directory before recording it prepared.
/// Unacknowledged creations are rejected before reaching this metadata check.
async fn validate_directory(
    sftp: &SftpSession,
    path: &str,
    metadata: russh_sftp::protocol::FileAttributes,
    cancel: &AtomicBool,
    require_empty: bool,
) -> AppResult<()> {
    if !metadata.is_dir()
        || metadata.is_symlink()
        || metadata
            .permissions
            .is_none_or(|mode| mode & 0o777 != 0o700)
        || (require_empty
            && !interruptible(Some(cancel), async {
                Ok(sftp
                    .read_dir(path)
                    .await
                    .map_err(map_sftp)?
                    .all(|entry| matches!(entry.file_name().as_str(), "." | "..")))
            })
            .await?)
    {
        return Err(AppError::TransferArtifactUnrecognized { path: path.into() });
    }
    Ok(())
}

/// Fence only an uncertain CREATE. No data writer can start until its opening
/// journal has been cleared; deleting the empty file and its parent is safe.
pub(super) async fn retire_remote_staging(
    id: &str,
    to: &Endpoint,
    sftp: &SftpSession,
    record: &ArtifactRecord,
    cancel: &AtomicBool,
) -> AppResult<()> {
    let staging = remote_staging(Some(record)).unwrap();
    if !staging.prepared || !staging.opening {
        return Err(AppError::internal(
            "Cannot retire an unacknowledged staging directory",
        ));
    }
    let directory = staging_directory(to, id, staging)?;
    let part = part_from_record(to, id, Some(record))?;
    interruptible(Some(cancel), async {
        match sftp.symlink_metadata(&directory.path).await {
            Err(error) if missing(&error) => return Ok(()),
            Err(error) => return Err(map_sftp(error)),
            Ok(metadata)
                if metadata.is_dir()
                    && !metadata.is_symlink()
                    && metadata
                        .permissions
                        .is_some_and(|mode| mode & 0o777 == 0o700) => {}
            Ok(_) => {
                return Err(AppError::TransferArtifactUnrecognized {
                    path: directory.path.clone(),
                })
            }
        }
        match sftp.symlink_metadata(&part.path).await {
            Ok(metadata) if metadata.is_regular() && metadata.size == Some(0) => {
                sftp.remove_file(&part.path).await.map_err(map_sftp)?;
            }
            Ok(_) => {
                return Err(AppError::TransferArtifactUnrecognized {
                    path: part.path.clone(),
                })
            }
            Err(error) if missing(&error) => {}
            Err(error) => return Err(map_sftp(error)),
        }
        // If a delayed OPEN races the unlink, RMDIR refuses a non-empty parent.
        // The unchanged journal makes the next attempt retry the same fence.
        match sftp.remove_dir(&directory.path).await {
            Ok(()) => Ok(()),
            Err(error) if missing(&error) => Ok(()),
            Err(error) => Err(map_sftp(error)),
        }
    })
    .await
}

#[cfg(test)]
mod tests;

/// Remove only a staging directory whose creation has a terminal acknowledgement.
/// A missing path cannot fence a MKDIR still queued on another connection.
pub(super) async fn cleanup_directory(
    sftp: &SftpSession,
    directory: &Endpoint,
    creation_pending: bool,
) -> AppResult<()> {
    if creation_pending {
        return Err(AppError::TransferArtifactUnrecognized {
            path: directory.path.clone(),
        });
    }
    match sftp.remove_dir(&directory.path).await {
        Ok(()) => Ok(()),
        Err(error) if missing(&error) => Ok(()),
        Err(error) => Err(map_sftp(error)),
    }
}

pub(super) fn unacknowledged_creation() -> bool {
    true
}

pub(super) fn require_creation_settled(
    id: &str,
    to: &Endpoint,
    record: Option<&ArtifactRecord>,
) -> AppResult<()> {
    if let Some(staging) = remote_staging(record) {
        if !staging.prepared && staging.creating {
            return Err(AppError::TransferArtifactUnrecognized {
                path: staging_directory(to, id, staging)?.path,
            });
        }
    }
    Ok(())
}

pub(in crate::ssh::files) fn creation_started(
    app: &AppHandle,
    id: &str,
    to: &Endpoint,
) -> AppResult<()> {
    let mut record = artifact_record(app, id, to)?;
    set_creating(app, id, to, &mut record, true)
}

pub(in crate::ssh::files) fn creation_rejected(
    app: &AppHandle,
    id: &str,
    to: &Endpoint,
) -> AppResult<()> {
    let mut record = artifact_record(app, id, to)?;
    set_creating(app, id, to, &mut record, false)
}

fn set_creating(
    app: &AppHandle,
    id: &str,
    to: &Endpoint,
    record: &mut Option<ArtifactRecord>,
    creating: bool,
) -> AppResult<()> {
    let Some(ArtifactRecord::Current {
        staging: Some(staging),
        ..
    }) = record
    else {
        return Err(AppError::internal("Missing staging creation checkpoint"));
    };
    staging.creating = creating;
    put(
        app,
        &artifact_key(id, to),
        serde_json::to_string(record.as_ref().unwrap())?,
    )
}
