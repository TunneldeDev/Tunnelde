use super::{interruptible, open_reader, source_stamp, verify_prefix, Endpoint, CANCELLED};
use crate::error::{AppError, AppResult};
use russh_sftp::client::SftpSession;
use std::sync::atomic::{AtomicBool, Ordering};

/// Only a guard covering both file objects through deletion permits completing
/// a copy-based move. Neither a matching digest nor metadata proves identity.
pub(super) fn require_guarded_deletion(guarded: bool, cancel: &AtomicBool) -> AppResult<()> {
    if cancel.load(Ordering::SeqCst) {
        return Err(AppError::Ssh(CANCELLED.into()));
    }
    if !guarded {
        return Err(AppError::validation("sftp.moveSourceRetained"));
    }
    Ok(())
}

/// Check the entire committed destination before a copy-based move can remove
/// its source. Metadata alone cannot detect same-size, same-timestamp changes.
/// Unlike the Windows local guard this cannot lock remote/Unix files against a
/// later write or replacement; callers must not treat it as conditional deletion.
pub(super) async fn verify(
    from: &Endpoint,
    to: &Endpoint,
    from_sftp: Option<&SftpSession>,
    to_sftp: Option<&SftpSession>,
    cancel: &AtomicBool,
) -> AppResult<()> {
    if cancel.load(Ordering::SeqCst) {
        return Err(AppError::Ssh(CANCELLED.into()));
    }
    interruptible(Some(cancel), async {
        let source_before = source_stamp(from, from_sftp).await?;
        let destination_before = source_stamp(to, to_sftp).await?;
        if source_before.0 != destination_before.0 {
            return Err(AppError::validation("sftp.moveVerificationFailed"));
        }
        let mut reader = open_reader(from, from_sftp).await?;
        let checked = verify_prefix(&mut reader, to, to_sftp, source_before.0, Some(cancel)).await;
        let closed = reader.finish().await;
        checked.map_err(|error| match error {
            AppError::Validation(ref message) if message == "sftp.resumePrefixMismatch" => {
                AppError::validation("sftp.moveVerificationFailed")
            }
            error => error,
        })?;
        closed?;
        if source_stamp(from, from_sftp).await? != source_before
            || source_stamp(to, to_sftp).await? != destination_before
        {
            return Err(AppError::validation("sftp.resumeSourceChanged"));
        }
        if cancel.load(Ordering::SeqCst) {
            return Err(AppError::Ssh(CANCELLED.into()));
        }
        Ok(())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ssh::files::CHUNK;
    use std::path::Path;

    fn local(path: &Path) -> Endpoint {
        Endpoint {
            session: None,
            path: path.to_string_lossy().into_owned(),
        }
    }

    fn temp_root(name: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("tunnelde-{name}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&root).unwrap();
        root
    }

    #[tokio::test]
    async fn move_verification_never_authorizes_path_deletion_of_replacements_or_open_writers() {
        let root = temp_root("move-review");
        let source = local(&root.join("source"));
        let target = local(&root.join("target"));
        let content = b"complete verified copy";
        std::fs::write(&source.path, content).unwrap();
        std::fs::write(&target.path, content).unwrap();
        let cancel = AtomicBool::new(false);
        verify(&source, &target, None, None, &cancel).await.unwrap();
        // Replace either endpoint after verification, keeping metadata/content
        // indistinguishable where possible. A pathname unlink cannot be safe.
        std::fs::remove_file(&source.path).unwrap();
        std::fs::write(&source.path, content).unwrap();
        std::fs::write(&target.path, b"changed destination").unwrap();
        let writer = std::fs::OpenOptions::new()
            .write(true)
            .open(&source.path)
            .unwrap();
        assert_eq!(
            require_guarded_deletion(false, &cancel)
                .unwrap_err()
                .to_string(),
            "sftp.moveSourceRetained"
        );
        assert_eq!(std::fs::read(&source.path).unwrap(), content);
        assert_eq!(std::fs::read(&target.path).unwrap(), b"changed destination");
        drop(writer);
        cancel.store(true, Ordering::SeqCst);
        assert_eq!(
            require_guarded_deletion(false, &cancel)
                .unwrap_err()
                .to_string(),
            CANCELLED
        );
        assert!(require_guarded_deletion(true, &cancel).is_err());
        cancel.store(false, Ordering::SeqCst);
        assert!(require_guarded_deletion(true, &cancel).is_ok());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn move_verification_checks_all_bytes_and_accepts_empty_files() {
        let root = temp_root("move-verification");
        let source = local(&root.join("source"));
        let target = local(&root.join("target"));
        let cancel = AtomicBool::new(false);
        for content in [vec![], vec![17; CHUNK * 3 + 19]] {
            std::fs::write(&source.path, &content).unwrap();
            std::fs::write(&target.path, &content).unwrap();
            verify(&source, &target, None, None, &cancel).await.unwrap();
            assert_eq!(std::fs::read(&source.path).unwrap(), content);
            assert_eq!(std::fs::read(&target.path).unwrap(), content);
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn move_verification_rejects_truncation_and_same_metadata_content_changes() {
        let root = temp_root("move-content-mismatch");
        let source = local(&root.join("source"));
        let target = local(&root.join("target"));
        let content = vec![17; CHUNK * 3 + 19];
        std::fs::write(&source.path, &content).unwrap();
        let cancel = AtomicBool::new(false);
        for changed in [b"short".to_vec(), {
            let mut changed = content.clone();
            changed[CHUNK * 2 + 7] ^= 1;
            changed
        }] {
            std::fs::write(&target.path, &content).unwrap();
            let original_modified = std::fs::metadata(&target.path).unwrap().modified().unwrap();
            std::fs::write(&target.path, &changed).unwrap();
            std::fs::File::options()
                .write(true)
                .open(&target.path)
                .unwrap()
                .set_times(std::fs::FileTimes::new().set_modified(original_modified))
                .unwrap();
            assert_eq!(
                verify(&source, &target, None, None, &cancel)
                    .await
                    .unwrap_err()
                    .to_string(),
                "sftp.moveVerificationFailed"
            );
            assert_eq!(std::fs::read(&source.path).unwrap(), content);
            assert_eq!(std::fs::read(&target.path).unwrap(), changed);
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test]
    async fn move_verification_preserves_io_errors_and_cancellation() {
        let root = temp_root("move-verification-errors");
        let source = local(&root.join("source"));
        let target = local(&root.join("missing-target"));
        std::fs::write(&source.path, b"keep source").unwrap();
        assert!(matches!(
            verify(&source, &target, None, None, &AtomicBool::new(false)).await,
            Err(AppError::Io(_))
        ));
        assert_eq!(
            verify(&source, &target, None, None, &AtomicBool::new(true))
                .await
                .unwrap_err()
                .to_string(),
            "sftp.cancelled"
        );
        assert_eq!(std::fs::read(&source.path).unwrap(), b"keep source");
        std::fs::remove_dir_all(root).unwrap();
    }
}
