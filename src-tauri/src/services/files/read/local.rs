use super::{budget, MAX_READ_BYTES, MAX_TEXT};
use crate::error::{AppError, AppResult};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

/// A pinned read handle, not an immutable snapshot or authority to mutate its path.
#[derive(Clone)]
pub struct LocalReader(Arc<Mutex<File>>);

impl LocalReader {
    pub async fn open(path: String) -> AppResult<(Self, u64)> {
        if path.len() > 32768 || path.contains('\0') {
            return Err(AppError::validation("fileRead.invalidPath"));
        }
        let path = PathBuf::from(path);
        if !path.is_absolute() {
            return Err(AppError::validation("fileRead.invalidPath"));
        }
        budget::run(move |job| {
            // Preserve intentional symlinks, then refuse replacements at the
            // final open. File identity is pinned by the handle, not the path.
            let path = std::fs::canonicalize(path)?;
            job.check()?;
            let file = crate::platform::regular_file::open_read(&path)?;
            let size = file.metadata()?.len();
            Ok((Self(Arc::new(Mutex::new(file))), size))
        })
        .await
    }

    pub async fn read(&self, start: u64, len: u64) -> AppResult<Vec<u8>> {
        if len > MAX_READ_BYTES || start.checked_add(len).is_none() {
            return Err(AppError::validation("fileRead.invalidRange"));
        }
        let reader = self.clone();
        budget::run(move |job| {
            let mut file = reader
                .0
                .lock()
                .map_err(|_| AppError::internal("fileRead.workerFailed"))?;
            job.check()?;
            file.seek(SeekFrom::Start(start))?;
            let mut bytes = vec![0; len as usize];
            file.read_exact(&mut bytes)?;
            Ok(bytes)
        })
        .await
    }

    /// One extra byte distinguishes an over-limit file from a complete prefix.
    /// Validation of text encoding and caller-specific size errors stays outside.
    pub async fn prefix(&self, maximum: usize) -> AppResult<Vec<u8>> {
        if maximum > MAX_TEXT {
            return Err(AppError::validation("fileRead.invalidRange"));
        }
        let reader = self.clone();
        budget::run(move |job| {
            let mut file = reader
                .0
                .lock()
                .map_err(|_| AppError::internal("fileRead.workerFailed"))?;
            job.check()?;
            file.seek(SeekFrom::Start(0))?;
            let mut bytes = Vec::new();
            (&mut *file)
                .take(maximum as u64 + 1)
                .read_to_end(&mut bytes)?;
            Ok(bytes)
        })
        .await
    }
}
