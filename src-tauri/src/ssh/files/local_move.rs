use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use tokio::io::{AsyncReadExt, AsyncSeekExt};

use crate::error::{AppError, AppResult};
use crate::platform::guarded_file::GuardedFile;

use super::{CANCELLED, CHUNK};

/// Hold the source before copying. Existing writers prevent acquisition;
/// ordinary writes, renames and replacement cannot race the later deletion.
pub(super) struct Source(GuardedFile);

/// Keep the destination locked across journal persistence and source deletion.
/// Dropping either stage without committing only releases its handles.
pub(super) struct Verified {
    source: GuardedFile,
    _destination: GuardedFile,
}

fn check_cancelled(cancel: &AtomicBool) -> AppResult<()> {
    if cancel.load(Ordering::SeqCst) {
        return Err(AppError::Ssh(CANCELLED.into()));
    }
    Ok(())
}

impl Source {
    pub(super) fn open(path: &Path) -> AppResult<Self> {
        Ok(Self(GuardedFile::deletable(path)?))
    }

    pub(super) async fn verify(
        self,
        destination: &Path,
        cancel: &AtomicBool,
    ) -> AppResult<Verified> {
        check_cancelled(cancel)?;
        let destination = GuardedFile::read(destination)?;
        let mut source_reader = tokio::fs::File::from_std(self.0.reader()?);
        let mut destination_reader = tokio::fs::File::from_std(destination.reader()?);
        source_reader.seek(std::io::SeekFrom::Start(0)).await?;
        destination_reader.seek(std::io::SeekFrom::Start(0)).await?;
        let mut remaining = source_reader.metadata().await?.len();
        if destination_reader.metadata().await?.len() != remaining {
            return Err(AppError::validation("sftp.moveVerificationFailed"));
        }
        let mut source_bytes = vec![0; CHUNK];
        let mut destination_bytes = vec![0; CHUNK];
        while remaining > 0 {
            check_cancelled(cancel)?;
            let count = remaining.min(CHUNK as u64) as usize;
            source_reader.read_exact(&mut source_bytes[..count]).await?;
            destination_reader
                .read_exact(&mut destination_bytes[..count])
                .await?;
            if source_bytes[..count] != destination_bytes[..count] {
                return Err(AppError::validation("sftp.moveVerificationFailed"));
            }
            remaining -= count as u64;
        }
        check_cancelled(cancel)?;
        Ok(Verified {
            source: self.0,
            _destination: destination,
        })
    }
}

impl Verified {
    pub(super) fn delete(self, cancel: &AtomicBool) -> AppResult<()> {
        check_cancelled(cancel)?;
        self.source.delete()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    struct Files {
        root: PathBuf,
        source: PathBuf,
        destination: PathBuf,
    }

    impl Files {
        fn new(content: &[u8]) -> Self {
            let root =
                std::env::temp_dir().join(format!("tunnelde-local-move-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir(&root).unwrap();
            let source = root.join("source");
            let destination = root.join("destination");
            std::fs::write(&source, content).unwrap();
            std::fs::write(&destination, content).unwrap();
            Self {
                root,
                source,
                destination,
            }
        }
    }

    impl Drop for Files {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.root).unwrap();
        }
    }

    #[tokio::test]
    async fn locks_before_copy_and_through_verified_source_deletion() {
        let content = vec![17; CHUNK * 3 + 19];
        let files = Files::new(&content);
        let source = Source::open(&files.source).unwrap();
        assert!(std::fs::write(&files.source, b"changed").is_err());
        assert!(std::fs::rename(&files.source, files.root.join("moved")).is_err());
        let cancel = AtomicBool::new(false);
        let verified = source.verify(&files.destination, &cancel).await.unwrap();
        let replacement = files.root.join("replacement");
        std::fs::write(&replacement, &content).unwrap();
        assert!(std::fs::rename(&replacement, &files.source).is_err());
        assert!(std::fs::rename(&replacement, &files.destination).is_err());
        assert!(std::fs::write(&files.destination, b"changed").is_err());
        assert!(std::fs::remove_file(&files.source).is_err());
        verified.delete(&cancel).unwrap();
        assert!(!files.source.exists());
        assert_eq!(std::fs::read(&files.destination).unwrap(), content);
        assert_eq!(std::fs::read(&replacement).unwrap(), content);
    }

    #[tokio::test]
    async fn preserves_both_files_on_length_or_same_length_content_mismatch() {
        let content = vec![17; CHUNK * 2 + 19];
        let files = Files::new(&content);
        let cancel = AtomicBool::new(false);
        for changed in [b"short".to_vec(), {
            let mut changed = content.clone();
            *changed.last_mut().unwrap() = 18;
            changed
        }] {
            std::fs::write(&files.destination, &changed).unwrap();
            let result = Source::open(&files.source)
                .unwrap()
                .verify(&files.destination, &cancel)
                .await;
            assert_eq!(
                result.err().unwrap().to_string(),
                "sftp.moveVerificationFailed"
            );
            assert_eq!(std::fs::read(&files.source).unwrap(), content);
            assert_eq!(std::fs::read(&files.destination).unwrap(), changed);
            // Failed verification must also release both handles for a retry.
            std::fs::write(&files.source, &content).unwrap();
        }
    }

    #[tokio::test]
    async fn cancellation_or_abandoned_journal_commit_only_releases_handles() {
        let files = Files::new(b"keep both files");
        let cancel = AtomicBool::new(true);
        let result = Source::open(&files.source)
            .unwrap()
            .verify(&files.destination, &cancel)
            .await;
        assert_eq!(result.err().unwrap().to_string(), CANCELLED);
        cancel.store(false, Ordering::SeqCst);
        let verified = Source::open(&files.source)
            .unwrap()
            .verify(&files.destination, &cancel)
            .await
            .unwrap();
        // This is also the journal-write failure path: dropping the verified
        // state without deleting must leave the source and target intact.
        drop(verified);
        std::fs::write(&files.source, b"keep both files").unwrap();
        let verified = Source::open(&files.source)
            .unwrap()
            .verify(&files.destination, &cancel)
            .await
            .unwrap();
        cancel.store(true, Ordering::SeqCst);
        assert_eq!(verified.delete(&cancel).unwrap_err().to_string(), CANCELLED);
        assert_eq!(std::fs::read(&files.source).unwrap(), b"keep both files");
        assert_eq!(
            std::fs::read(&files.destination).unwrap(),
            b"keep both files"
        );
    }

    #[tokio::test]
    async fn empty_file_moves_and_existing_writer_failures_preserve_independent_data() {
        use std::fs::OpenOptions;
        let files = Files::new(b"");
        let cancel = AtomicBool::new(false);
        let source_writer = OpenOptions::new().write(true).open(&files.source).unwrap();
        assert!(Source::open(&files.source).is_err());
        drop(source_writer);
        let destination_writer = OpenOptions::new()
            .write(true)
            .open(&files.destination)
            .unwrap();
        assert!(Source::open(&files.source)
            .unwrap()
            .verify(&files.destination, &cancel)
            .await
            .is_err());
        drop(destination_writer);
        Source::open(&files.source)
            .unwrap()
            .verify(&files.destination, &cancel)
            .await
            .unwrap()
            .delete(&cancel)
            .unwrap();
        assert!(!files.source.exists());
        assert_eq!(std::fs::read(&files.destination).unwrap(), b"");
    }
}
