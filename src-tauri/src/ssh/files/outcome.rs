//! A stop request must not hide failed completion or recovery evidence.
use super::{AppError, AppResult, AtomicBool, Ordering, CANCELLED};

pub(super) enum Outcome {
    Done(u64),
    Cancelled(u64),
    Failed(u64, AppError),
}

fn cancelled(error: &AppError) -> bool {
    matches!(error.original(), AppError::Ssh(reason) if reason == CANCELLED)
}

impl Outcome {
    pub(super) fn into_result(self) -> AppResult<()> {
        match self {
            Self::Done(_) => Ok(()),
            Self::Cancelled(_) => Err(AppError::Ssh(CANCELLED.into())),
            Self::Failed(_, error) => Err(error),
        }
    }

    pub(super) fn from_result(
        result: AppResult<()>,
        transferred: u64,
        cancel: &AtomicBool,
    ) -> Self {
        match result {
            Ok(()) => Self::Done(transferred),
            Err(error) if cancel.load(Ordering::SeqCst) && cancelled(&error) => {
                Self::Cancelled(transferred)
            }
            Err(error) => Self::Failed(transferred, error),
        }
    }
}

/// Completion has already run. Preserve an actionable operation error (including
/// its backup/artifact details), but never hide failed CLOSE/parking behind an
/// ordinary cancellation. Neither result is evidence of an unobserved reply.
pub(super) fn after_completion(
    operation: AppResult<()>,
    completion: AppResult<()>,
) -> AppResult<()> {
    match operation {
        Err(error) if !cancelled(&error) => {
            if let Err(completion) = completion {
                tracing::warn!(target: "files.transfer", %error, %completion,
                    "Transfer operation and completion both failed");
            }
            Err(error)
        }
        operation => completion.and(operation),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requested_cancel_preserves_real_failures_and_recovery_details() {
        let cancel = AtomicBool::new(true);
        for error in [
            AppError::validation("editor.remoteOutcomeUnknown"),
            AppError::Ssh("sftp.transferTimedOut".into()),
            AppError::Ssh("permission denied".into()),
            AppError::BackupRecovery {
                backup: "/original-backup".into(),
                destination: "/target".into(),
            },
            AppError::TransferCreationUnconfirmed {
                path: "/stage".into(),
            },
        ] {
            let expected = serde_json::to_value(&error).unwrap();
            match Outcome::from_result(Err(error), 42, &cancel) {
                Outcome::Failed(42, error) => {
                    assert_eq!(serde_json::to_value(error).unwrap(), expected);
                }
                _ => panic!("cancel request masked an actual failure"),
            }
        }
    }

    #[test]
    fn failed_close_and_parking_override_cancellation_without_losing_progress() {
        let cancel = AtomicBool::new(true);
        let closed = after_completion(
            Err(AppError::Ssh(CANCELLED.into())),
            Err(AppError::Ssh("sftp.transferTimedOut".into())),
        );
        let parked = after_completion(
            closed,
            Err(AppError::validation("editor.remoteOutcomeUnknown")),
        );
        match Outcome::from_result(parked, 8192, &cancel) {
            Outcome::Failed(8192, error) => assert_eq!(error.to_string(), "sftp.transferTimedOut"),
            _ => panic!("unconfirmed completion reported as a clean pause"),
        }
        let parked = after_completion(
            Err(AppError::Ssh(CANCELLED.into())),
            Err(AppError::validation("editor.remoteOutcomeUnknown")),
        );
        assert!(matches!(
            Outcome::from_result(parked, 42, &cancel),
            Outcome::Failed(42, _)
        ));
        let parked = after_completion(Err(AppError::Ssh(CANCELLED.into())), Ok(()));
        assert!(matches!(
            Outcome::from_result(parked, 42, &cancel),
            Outcome::Cancelled(42)
        ));
        assert!(matches!(
            Outcome::from_result(after_completion(Ok(()), Ok(())), 42, &cancel),
            Outcome::Done(42)
        ));
    }
}
