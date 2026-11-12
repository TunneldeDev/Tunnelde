//! Retrying known staging cleanup is owned by a bounded network worker.
use super::*;
use crate::services::files::operations::Budget;
use std::future::Future;

pub(super) async fn retry_with<J, F, W>(
    budget: &Budget,
    mut record: Record,
    open: F,
    journal: J,
) -> AppResult<()>
where
    J: Journal,
    F: FnOnce() -> W + Send + 'static,
    W: Future<Output = AppResult<SftpSession>> + Send + 'static,
{
    budget
        .asynchronous(move |job| async move {
            let held = Reservation::acquire(&record.id, true)?;
            // A retry captured before waiting for admission must not recreate
            // a retired journal or replay an older recovery phase.
            record = journal.current(&record)?;
            journal.changed();
            let result: AppResult<()> = async {
                recovery::require_settled(&record)?;
                let sftp = open().await?;
                let result: AppResult<()> = async {
                    let claim = journal.cleanup_admission(&sftp, &record).await?;
                    let active = if let Some(claim) = claim {
                        Some(claim.dispatch(&job).await?)
                    } else {
                        None
                    };
                    cleanup(&sftp, &mut record, |r| journal.persist(r)).await?;
                    journal.forget(&record)?;
                    if let Some(active) = active {
                        active.settle().await?;
                    }
                    Ok(())
                }
                .await;
                let _ = tokio::time::timeout(std::time::Duration::from_secs(2), sftp.close()).await;
                result
            }
            .await;
            let persisted = if let Err(error) = &result {
                record.error = Some(error.to_string());
                record.updated_at = crate::models::now_ms();
                journal.persist(&record)
            } else {
                Ok(())
            };
            drop(held);
            journal.changed();
            persisted?;
            result
        })
        .await
}
