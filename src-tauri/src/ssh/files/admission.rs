//! Existing native recovery fences for legacy remote mutations.
use super::*;

/// Caller cancellation affects delivery; the actual admitted mutation worker
/// owns its durable checkpoint and response until settlement or timeout.
pub(super) async fn mutate<F, W>(
    app: &AppHandle,
    session_id: &str,
    paths: Vec<String>,
    kind: native_save::runtime::MutationKind,
    action: F,
) -> AppResult<()>
where
    F: FnOnce(Arc<SftpSession>) -> W + Send + 'static,
    W: std::future::Future<Output = AppResult<()>> + Send + 'static,
{
    let app = app.clone();
    let session_id = session_id.to_owned();
    let worker = crate::services::files::write::REMOTE_BUDGET.asynchronous(move |job| async move {
        let destination = app.state::<AppState>().ssh.identity(&session_id)?;
        let native = app.state::<AppState>().native_saves.clone();
        let sftp = Arc::new(session(&app, &session_id).await?);
        let result = native
            .mutate(&destination, &sftp, kind, &paths, &job, || async {
                if app.state::<AppState>().ssh.identity(&session_id)? != destination {
                    return Err(AppError::validation("editor.nativeChanged"));
                }
                action(sftp.clone()).await
            })
            .await;
        let _ = tokio::time::timeout(std::time::Duration::from_secs(2), sftp.close()).await;
        let _ = app.emit("editor://cleanup-changed", ());
        result
    });
    // Expiring UI delivery cancels only pre-dispatch work. The budget's spawned
    // worker keeps observing an admitted mutation and owns its durable claim.
    tokio::time::timeout(std::time::Duration::from_secs(30), worker)
        .await
        .map_err(|_| AppError::validation("editor.remoteOperationWaiting"))?
}

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
