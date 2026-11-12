use super::{LocalReader, RemoteReader};
use crate::error::AppResult;

/// A native read-only source, independent of host preview tickets or plugin RPCs.
#[derive(Clone)]
pub enum Source {
    Local(LocalReader),
    Remote(RemoteReader),
}

impl Source {
    /// Retire the dedicated network channel. Running local IO remains charged
    /// to its actual worker and releases its cloned file when it settles.
    pub fn retire(&self) {
        if let Self::Remote(reader) = self {
            reader.retire();
        }
    }

    pub async fn open(
        app: &tauri::AppHandle,
        session_id: Option<&str>,
        path: &str,
    ) -> AppResult<(Self, u64)> {
        match session_id {
            Some(session) => {
                let (reader, size) =
                    RemoteReader::open(app.clone(), session.into(), path.into()).await?;
                Ok((Self::Remote(reader), size))
            }
            None => {
                let (reader, size) = LocalReader::open(path.into()).await?;
                Ok((Self::Local(reader), size))
            }
        }
    }

    pub async fn read(&self, offset: u64, len: u64) -> AppResult<Vec<u8>> {
        match self {
            Self::Local(reader) => reader.read(offset, len).await,
            Self::Remote(reader) => reader.read(offset, len).await,
        }
    }

    pub async fn close(self) {
        if let Self::Remote(reader) = self {
            reader.close().await;
        }
    }
}
