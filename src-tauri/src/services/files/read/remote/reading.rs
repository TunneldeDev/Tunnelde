use super::*;
use crate::services::files::read::{budget, MAX_READ_BYTES};

impl RemoteReader {
    pub async fn read(&self, offset: u64, len: u64) -> AppResult<Vec<u8>> {
        self.read_with_deadline(offset, len, std::time::Duration::from_secs(30))
            .await
    }

    pub(super) async fn read_with_deadline(
        &self,
        offset: u64,
        len: u64,
        deadline: std::time::Duration,
    ) -> AppResult<Vec<u8>> {
        if len > MAX_READ_BYTES || offset.checked_add(len).is_none() {
            return Err(AppError::validation("fileRead.invalidRange"));
        }
        let reader = self.clone();
        budget::run_async(move |job| async move {
            let work = async {
                let mut bytes = Vec::with_capacity(len as usize);
                while bytes.len() < len as usize {
                    job.check()?;
                    let count = (len as usize - bytes.len()).min(reader.0.read_size);
                    let reply = reader
                        .0
                        .raw
                        .read(
                            reader.0.handle.clone(),
                            offset + bytes.len() as u64,
                            count as u32,
                        )
                        .await
                        .map_err(|error| {
                            // After an uncertain request, close this dedicated data
                            // channel rather than releasing its work budget while
                            // retaining a live connection with unknown pending IO.
                            let _ = reader.0.raw.close_session();
                            match error {
                                russh_sftp::client::error::Error::Status(status)
                                    if status.status_code
                                        == russh_sftp::protocol::StatusCode::Eof =>
                                {
                                    AppError::validation("fileRead.sourceChanged")
                                }
                                error => map_sftp(error),
                            }
                        })?;
                    job.check()?;
                    if reply.data.is_empty() || reply.data.len() > count {
                        let _ = reader.0.raw.close_session();
                        return Err(AppError::validation("fileRead.invalidReply"));
                    }
                    bytes.extend_from_slice(&reply.data);
                }
                job.check()?;
                Ok(bytes)
            };
            match tokio::time::timeout(deadline, work).await {
                Ok(result) => result,
                Err(_) => {
                    let _ = reader.0.raw.close_session();
                    Err(AppError::Ssh("sftp.transferTimedOut".into()))
                }
            }
        })
        .await
    }
}
