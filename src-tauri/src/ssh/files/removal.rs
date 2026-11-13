//! Recursive removal uses the same typed mutation replies for explicit deletes
//! and transfer source removal. Every descendant keeps its original admission.
use super::*;
use std::future::Future;

#[derive(Clone, Copy)]
pub(super) enum Observer<'a> {
    Authorized(&'a mutations::Dispatch),
    Transfer(&'a native_save::runtime::MutationObservation),
}

impl Observer<'_> {
    async fn request<T>(
        self,
        work: impl Future<Output = Result<T, russh_sftp::client::error::Error>>,
    ) -> AppResult<T> {
        match self {
            Self::Authorized(dispatch) => dispatch.request(work).await,
            Self::Transfer(observation) => observation.request(work).await.map_err(map_sftp),
        }
    }
}

pub(super) async fn entry(sftp: &SftpSession, path: &str, observer: Observer<'_>) -> AppResult<()> {
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
            Box::pin(entry(sftp, &child, observer)).await?;
        }
        observer.request(sftp.remove_dir(path)).await
    } else {
        observer.request(sftp.remove_file(path)).await
    }
}
