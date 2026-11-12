//! Existing native recovery fences for legacy remote mutations.
use super::*;

pub(super) async fn open(
    app: &AppHandle,
    session_id: &str,
    paths: &[&str],
) -> AppResult<SftpSession> {
    let sftp = session(app, session_id).await?;
    if let Err(error) = writable(app, session_id, &sftp, paths).await {
        let _ = tokio::time::timeout(std::time::Duration::from_secs(2), sftp.close()).await;
        return Err(error);
    }
    Ok(sftp)
}

pub(super) async fn writable(
    app: &AppHandle,
    session_id: &str,
    sftp: &SftpSession,
    paths: &[&str],
) -> AppResult<()> {
    let state = app.state::<AppState>();
    let destination = state.ssh.identity(session_id)?;
    state.native_saves.writable(&destination, sftp, paths).await
}

pub(super) async fn transfer(
    app: &AppHandle,
    from: &Endpoint,
    to: &Endpoint,
    from_sftp: Option<&SftpSession>,
    to_sftp: Option<&SftpSession>,
    remove_source: bool,
) -> AppResult<()> {
    if let (Some(session_id), Some(sftp)) = (to.session.as_deref(), to_sftp) {
        writable(app, session_id, sftp, &[&to.path]).await?;
    }
    if remove_source {
        if let (Some(session_id), Some(sftp)) = (from.session.as_deref(), from_sftp) {
            writable(app, session_id, sftp, &[&from.path]).await?;
        }
    }
    Ok(())
}
