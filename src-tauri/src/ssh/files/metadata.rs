//! Owned metadata requests keep the original channel and response after the
//! transfer caller stops waiting. No operation is reconstructed or replayed.
use super::*;
use russh_sftp::client::error::Error;

pub(super) async fn close(session: Arc<SftpSession>) {
    if let Ok(session) = Arc::try_unwrap(session) {
        let _ = tokio::time::timeout(std::time::Duration::from_secs(5), session.close()).await;
    }
}

pub(super) async fn rename(
    session: &Arc<SftpSession>,
    from: &str,
    to: &str,
    observation: &native_save::runtime::MutationObservation,
) -> Result<(), Error> {
    let session = session.clone();
    let from = from.to_owned();
    let to = to.to_owned();
    observation
        .retained(async move { session.rename(from, to).await })
        .await
}

pub(super) async fn remove_file(
    session: &Arc<SftpSession>,
    path: &str,
    observation: &native_save::runtime::MutationObservation,
) -> Result<(), Error> {
    let session = session.clone();
    let path = path.to_owned();
    observation
        .retained(async move { session.remove_file(path).await })
        .await
}

pub(super) async fn remove_dir(
    session: &Arc<SftpSession>,
    path: &str,
    observation: &native_save::runtime::MutationObservation,
) -> Result<(), Error> {
    let session = session.clone();
    let path = path.to_owned();
    observation
        .retained(async move { session.remove_dir(path).await })
        .await
}
