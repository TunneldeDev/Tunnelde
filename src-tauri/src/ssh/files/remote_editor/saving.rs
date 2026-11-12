//! Owned write workers retain locks and cleanup through caller cancellation.
use super::*;
use crate::services::files::operations::{Budget, Cancellation};
use std::future::Future;

pub(super) struct Request {
    pub session_id: String,
    pub host_id: String,
    pub address: String,
    pub path: String,
    pub content: String,
    pub baseline: Option<String>,
}

pub(super) async fn save_with<J, F, W, R>(
    budget: &Budget,
    request: Request,
    policy: impl policy::Policy,
    open: F,
    journal: J,
) -> AppResult<()>
where
    J: Journal,
    F: FnOnce(Cancellation) -> W + Send + 'static,
    W: Future<Output = AppResult<(SftpSession, R)>> + Send + 'static,
    R: Future<Output = AppResult<remote_commit::Replacement>> + Send + 'static,
{
    budget
        .asynchronous(move |job| async move {
            // Opening channels is charged to the actual worker, not the RPC.
            policy.authorize()?;
            let (sftp, replacement) = open(job.clone()).await?;
            let result = save_opened(&sftp, replacement, &request, &journal, &job, &policy).await;
            let _ = sftp.close().await;
            result
        })
        .await
}

async fn save_opened(
    sftp: &SftpSession,
    replacement: impl Future<Output = AppResult<remote_commit::Replacement>>,
    request: &Request,
    journal: &impl Journal,
    job: &Cancellation,
    policy: &impl policy::Policy,
) -> AppResult<()> {
    job.check()?;
    let target = sftp.canonicalize(&request.path).await.map_err(map_sftp)?;
    if !target.starts_with('/') || target.contains('\0') {
        return Err(AppError::validation("sftp.absolutePathRequired"));
    }
    let lock = lock_for(format!("{}\0{target}", request.address));
    let _guard = lock.lock().await;
    // An earlier request may still be queued on another server connection.
    // Serialize future edits against its retained unknown outcome as well.
    journal.writable(&request.address, &target)?;
    job.check()?;
    policy.authorize()?;
    let original = read_remote_text(sftp, &target).await?;
    job.check()?;
    policy.check(sftp, &target, &original.content).await?;
    job.check()?;
    if original.content == request.content {
        policy.admit(job)?;
        journal.published(&request.session_id);
        return Ok(());
    }
    if request
        .baseline
        .as_ref()
        .is_some_and(|expected| expected != &original.content)
    {
        return Err(AppError::validation("editor.remoteFileChanged"));
    }
    // Negotiate only for a real save, after validating the original. A no-op
    // must still succeed on a server without atomic replacement support.
    let replacement = replacement.await?;
    job.check()?;
    let id = uuid::Uuid::new_v4().to_string();
    let parent = target
        .rsplit_once('/')
        .map(|(parent, _)| parent)
        .unwrap_or("");
    let mut record = Record {
        directory: format!("{parent}/.tunnelde-save-{id}"),
        id,
        host_id: request.host_id.clone(),
        address: request.address.clone(),
        path: target.clone(),
        token: uuid::Uuid::new_v4().to_string(),
        receipt: Some(recovery::Receipt::new()),
        removing_marker: false,
        updated_at: crate::models::now_ms(),
        error: None,
    };
    let reservation = Reservation::acquire(&record.id, false)?;
    journal.create(&record)?;
    let result = staged_save(
        sftp,
        &replacement,
        transaction::Draft {
            requested: &request.path,
            target: &target,
            content: &request.content,
            baseline: &original.content,
        },
        &mut record,
        job,
        policy,
        transaction::Observer {
            checkpoint: &|r| journal.persist(r),
            published: &|| journal.published(&request.session_id),
        },
    )
    .await;
    // Do not cancel safe cleanup when a caller disappears. A network timeout
    // still does not prove the server had no side effect: preserve unknown data.
    let settled = match cleanup(sftp, &mut record, |r| journal.persist(r)).await {
        Ok(()) => journal.forget(&record),
        Err(error) => {
            tracing::warn!(%error, path = %record.directory, "Remote editor staging cleanup deferred");
            record.error = Some(error.to_string());
            record.updated_at = crate::models::now_ms();
            journal.persist(&record)
        }
    };
    drop(reservation);
    journal.changed();
    settled?;
    result
}
