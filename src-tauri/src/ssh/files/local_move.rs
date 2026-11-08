use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};

use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncSeekExt};

use crate::error::{AppError, AppResult};
use crate::platform::guarded_file::GuardedFile;

use super::{durable::MoveRecovery, CANCELLED, CHUNK};

/// Hold the source before copying. Existing writers prevent acquisition;
/// ordinary writes, renames and replacement cannot race the later deletion.
pub(super) struct Source(GuardedFile);

/// Keep the destination locked across journal persistence and source deletion.
/// Dropping either stage without committing only releases its handles.
pub(super) struct Verified {
    source: GuardedFile,
    _destination: GuardedFile,
    proof: MoveRecovery,
}

fn check_cancelled(cancel: &AtomicBool) -> AppResult<()> {
    if cancel.load(Ordering::SeqCst) {
        return Err(AppError::Ssh(CANCELLED.into()));
    }
    Ok(())
}

impl Source {
    pub(super) fn open(path: &Path) -> AppResult<Self> {
        let file = GuardedFile::deletable(path)?;
        if file.has_named_streams()? {
            return Err(AppError::validation("sftp.namedStreamsMoveUnavailable"));
        }
        Ok(Self(file))
    }

    pub(super) fn identity(&self) -> AppResult<crate::platform::file_identity::FileIdentity> {
        Ok(self.0.identity()?)
    }

    pub(super) fn length(&self) -> AppResult<u64> {
        Ok(self.0.reader()?.metadata()?.len())
    }

    pub(super) async fn verify(
        self,
        destination: &Path,
        cancel: &AtomicBool,
    ) -> AppResult<Verified> {
        check_cancelled(cancel)?;
        let destination = GuardedFile::syncable(destination)?;
        self.verify_guarded(destination, cancel).await
    }

    async fn verify_guarded(
        self,
        destination: GuardedFile,
        cancel: &AtomicBool,
    ) -> AppResult<Verified> {
        let mut source_reader = tokio::fs::File::from_std(self.0.reader()?);
        let mut destination_reader = tokio::fs::File::from_std(destination.reader()?);
        source_reader.seek(std::io::SeekFrom::Start(0)).await?;
        destination_reader.seek(std::io::SeekFrom::Start(0)).await?;
        let mut remaining = source_reader.metadata().await?.len();
        let length = remaining;
        if destination_reader.metadata().await?.len() != remaining {
            return Err(AppError::validation("sftp.moveVerificationFailed"));
        }
        let mut source_bytes = vec![0; CHUNK];
        let mut destination_bytes = vec![0; CHUNK];
        let mut hash = Sha256::new();
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
            hash.update(&source_bytes[..count]);
            remaining -= count as u64;
        }
        check_cancelled(cancel)?;
        // Do not remove the original while the only verified copy is still in
        // volatile write buffers. The write-capable guard stays held afterward.
        destination_reader.sync_all().await?;
        let proof = MoveRecovery {
            source: self.0.identity()?,
            destination: destination.identity()?,
            length,
            sha256: format!("{:x}", hash.finalize()),
        };
        Ok(Verified {
            source: self.0,
            _destination: destination,
            proof,
        })
    }
}

impl Verified {
    pub(super) fn proof(&self) -> &MoveRecovery {
        &self.proof
    }

    pub(super) fn delete(self, cancel: &AtomicBool) -> AppResult<()> {
        check_cancelled(cancel)?;
        if self.source.has_named_streams()? {
            return Err(AppError::validation("sftp.namedStreamsMoveUnavailable"));
        }
        self.source.delete()?;
        Ok(())
    }
}

/// Never start the copy phase again after deletion intent was committed. A
/// restart releases the old locks, so both identities and all bytes need fresh
/// verification before deleting anything or acknowledging a missing source.
pub(super) async fn recover(
    source: &Path,
    destination: &Path,
    proof: &MoveRecovery,
    cancel: &AtomicBool,
) -> AppResult<()> {
    check_cancelled(cancel)?;
    let unverified = || AppError::validation("sftp.moveRecoveryUnverified");
    match Source::open(source) {
        Ok(source) => {
            if source.0.identity()? != proof.source {
                return Err(unverified());
            }
            let destination = GuardedFile::syncable(destination)?;
            if destination.identity()? != proof.destination {
                return Err(unverified());
            }
            let verified = source.verify_guarded(destination, cancel).await.map_err(|error| {
                if matches!(&error, AppError::Validation(key) if key == "sftp.moveVerificationFailed") {
                    unverified()
                } else {
                    error
                }
            })?;
            if verified.proof() != proof {
                return Err(unverified());
            }
            verified.delete(cancel)
        }
        Err(AppError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => {
            let destination = GuardedFile::read(destination)?;
            if destination.identity()? != proof.destination {
                return Err(unverified());
            }
            let mut reader = tokio::fs::File::from_std(destination.reader()?);
            if reader.metadata().await?.len() != proof.length {
                return Err(unverified());
            }
            let mut hash = Sha256::new();
            let mut bytes = vec![0; CHUNK];
            loop {
                check_cancelled(cancel)?;
                let count = reader.read(&mut bytes).await?;
                if count == 0 {
                    break;
                }
                hash.update(&bytes[..count]);
            }
            if format!("{:x}", hash.finalize()) != proof.sha256 {
                return Err(unverified());
            }
            check_cancelled(cancel)
        }
        Err(error) => Err(error),
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
    async fn named_streams_present_before_copy_or_added_after_verification_keep_the_source() {
        for added_after_verification in [false, true] {
            let files = Files::new(b"ordinary data");
            let stream = PathBuf::from(format!("{}:metadata", files.source.display()));
            let verified = if added_after_verification {
                Some(
                    Source::open(&files.source)
                        .unwrap()
                        .verify(&files.destination, &AtomicBool::new(false))
                        .await
                        .unwrap(),
                )
            } else {
                None
            };
            // Stream sharing is independent from the unnamed stream. A normal
            // write-denying file handle does not freeze the set of stream names.
            std::fs::write(&stream, b"extra source data").unwrap();
            let error = match verified {
                Some(verified) => verified.delete(&AtomicBool::new(false)).err().unwrap(),
                None => Source::open(&files.source).err().unwrap(),
            };
            assert_eq!(error.to_string(), "sftp.namedStreamsMoveUnavailable");
            assert_eq!(std::fs::read(&stream).unwrap(), b"extra source data");
            assert_eq!(std::fs::read(&files.source).unwrap(), b"ordinary data");
        }
    }

    async fn checkpoint(files: &Files) -> MoveRecovery {
        let verified = Source::open(&files.source)
            .unwrap()
            .verify(&files.destination, &AtomicBool::new(false))
            .await
            .unwrap();
        // Roundtrip the persisted proof and drop all original handles, as when
        // the process exits after committing intent but before deleting source.
        serde_json::from_str(&serde_json::to_string(verified.proof()).unwrap()).unwrap()
    }

    #[tokio::test]
    async fn restart_recovers_before_and_after_source_deletion_including_empty_files() {
        for content in [vec![], vec![29; CHUNK * 3 + 7]] {
            let files = Files::new(&content);
            let proof = checkpoint(&files).await;
            assert_eq!(proof.length, content.len() as u64);
            assert_eq!(proof.sha256, format!("{:x}", Sha256::digest(&content)));
            let cancel = AtomicBool::new(false);
            recover(&files.source, &files.destination, &proof, &cancel)
                .await
                .unwrap();
            assert!(!files.source.exists());
            assert_eq!(std::fs::read(&files.destination).unwrap(), content);
            // Another interruption after deletion, before 'done' is recorded,
            // can acknowledge the original destination without copying again.
            recover(&files.source, &files.destination, &proof, &cancel)
                .await
                .unwrap();
            assert_eq!(std::fs::read(&files.destination).unwrap(), content);
        }
    }

    #[tokio::test]
    async fn restart_preserves_identical_replacements_at_either_path() {
        for replace_source in [true, false] {
            let files = Files::new(b"identical bytes are not object identity");
            let proof = checkpoint(&files).await;
            let replaced = if replace_source {
                &files.source
            } else {
                &files.destination
            };
            // Keep the old object alive so even an aggressively reusing
            // filesystem cannot give the replacement its old identity.
            std::fs::rename(replaced, files.root.join("original")).unwrap();
            std::fs::write(replaced, b"identical bytes are not object identity").unwrap();
            assert_eq!(
                recover(
                    &files.source,
                    &files.destination,
                    &proof,
                    &AtomicBool::new(false)
                )
                .await
                .unwrap_err()
                .to_string(),
                "sftp.moveRecoveryUnverified"
            );
            assert!(files.source.exists());
            assert!(files.destination.exists());
            assert!(files.root.join("original").exists());
        }
    }

    #[tokio::test]
    async fn restart_rejects_content_changed_on_both_original_objects() {
        let files = Files::new(b"original");
        let proof = checkpoint(&files).await;
        // The new bytes match each other and retain the original lengths and
        // identities, but must not authorize deletion using the old checkpoint.
        std::fs::write(&files.source, b"modified").unwrap();
        std::fs::write(&files.destination, b"modified").unwrap();
        assert_eq!(
            recover(
                &files.source,
                &files.destination,
                &proof,
                &AtomicBool::new(false)
            )
            .await
            .unwrap_err()
            .to_string(),
            "sftp.moveRecoveryUnverified"
        );
        assert_eq!(std::fs::read(&files.source).unwrap(), b"modified");
        assert_eq!(std::fs::read(&files.destination).unwrap(), b"modified");
    }

    #[tokio::test]
    async fn missing_source_still_requires_original_complete_destination() {
        for replacement in [false, true] {
            let files = Files::new(b"original");
            let proof = checkpoint(&files).await;
            std::fs::remove_file(&files.source).unwrap();
            if replacement {
                std::fs::rename(&files.destination, files.root.join("original")).unwrap();
                std::fs::write(&files.destination, b"original").unwrap();
            } else {
                std::fs::write(&files.destination, b"modified").unwrap();
            }
            assert_eq!(
                recover(
                    &files.source,
                    &files.destination,
                    &proof,
                    &AtomicBool::new(false)
                )
                .await
                .unwrap_err()
                .to_string(),
                "sftp.moveRecoveryUnverified"
            );
            assert!(files.destination.exists());
        }
    }

    #[tokio::test]
    async fn restart_cancellation_and_busy_writer_preserve_files_and_allow_retry() {
        let files = Files::new(b"original");
        let proof = checkpoint(&files).await;
        let cancel = AtomicBool::new(true);
        assert_eq!(
            recover(&files.source, &files.destination, &proof, &cancel)
                .await
                .unwrap_err()
                .to_string(),
            CANCELLED
        );
        cancel.store(false, Ordering::SeqCst);
        for path in [&files.source, &files.destination] {
            let writer = std::fs::OpenOptions::new().write(true).open(path).unwrap();
            assert!(recover(&files.source, &files.destination, &proof, &cancel)
                .await
                .is_err());
            assert!(files.source.exists());
            assert!(files.destination.exists());
            drop(writer);
        }
        recover(&files.source, &files.destination, &proof, &cancel)
            .await
            .unwrap();
        assert!(!files.source.exists());
        assert_eq!(std::fs::read(&files.destination).unwrap(), b"original");
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
