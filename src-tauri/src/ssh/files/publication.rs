//! Interrupted publication is fenced by moving its immutable source to a new
//! staging generation before any resumed writes. The successor is journalled
//! before the rename, so a lost recovery acknowledgement is also recoverable.
use super::*;

pub(super) async fn commit(
    from: &Endpoint,
    to: &Endpoint,
    sftp: Option<&Arc<SftpSession>>,
    cancel: &AtomicBool,
    observation: &native_save::runtime::MutationObservation,
) -> AppResult<()> {
    match sftp {
        Some(sftp) => {
            interruptible(Some(cancel), async {
                metadata::rename(sftp, &from.path, &to.path, observation)
                    .await
                    .map_err(|error| rename::failure(&from.path, &to.path, error))
            })
            .await
        }
        // A blocking local rename must settle before releasing its file guard.
        None => rename_endpoint(from, to, None, observation).await,
    }
}

/// Returns true when the immutable staging file survived. Neither path may be
/// recreated until this succeeds; a delayed original commit then has no source.
pub(super) async fn fence(
    previous: &Endpoint,
    successor: &Endpoint,
    sftp: &Arc<SftpSession>,
    cancel: &AtomicBool,
    observation: &native_save::runtime::MutationObservation,
) -> AppResult<bool> {
    if previous.path == successor.path {
        return Err(AppError::internal("Publication staging generation reused"));
    }
    if interruptible(Some(cancel), file_length(successor, Some(sftp)))
        .await?
        .is_some()
    {
        if interruptible(Some(cancel), file_length(previous, Some(sftp)))
            .await?
            .is_some()
        {
            return Err(AppError::TransferArtifactUnrecognized {
                path: successor.path.clone(),
            });
        }
        return Ok(true);
    }
    interruptible(Some(cancel), async {
        match metadata::rename(sftp, &previous.path, &successor.path, observation).await {
            Ok(()) => Ok(true),
            Err(russh_sftp::client::error::Error::Status(status))
                if status.status_code == StatusCode::NoSuchFile =>
            {
                // The original commit or an earlier recovery may have won.
                // The caller verifies the published destination if both paths
                // are gone, rather than blindly retrying an overwrite.
                Ok(file_length(successor, Some(sftp)).await?.is_some())
            }
            Err(error) => Err(map_sftp(error)),
        }
    })
    .await
}

#[cfg(test)]
mod tests;
