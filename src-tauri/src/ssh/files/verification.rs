use super::{
    interruptible, open_reader, source_stamp, BackupFingerprint, Endpoint, Reader, CANCELLED, CHUNK,
};
use crate::error::{AppError, AppResult};
use russh_sftp::client::SftpSession;
use sha2::{Digest, Sha256};
use std::sync::atomic::{AtomicBool, Ordering};

pub(super) async fn verify_prefix(
    reader: &mut Reader,
    partial: &Endpoint,
    sftp: Option<&SftpSession>,
    length: u64,
    cancel: Option<&AtomicBool>,
) -> AppResult<()> {
    verify_range(reader, partial, sftp, 0, length, cancel).await
}

pub(super) async fn verify_range(
    reader: &mut Reader,
    partial: &Endpoint,
    sftp: Option<&SftpSession>,
    offset: u64,
    length: u64,
    cancel: Option<&AtomicBool>,
) -> AppResult<()> {
    // This entire operation owns only read handles. Cancellation may abandon
    // OPEN/READ/CLOSE replies without stopping a shared channel or a writer.
    interruptible(cancel, async {
        let mut other = open_reader(partial, sftp).await?;
        let mut left = length;
        let mut a = vec![0; CHUNK];
        let mut b = vec![0; CHUNK];
        let result = async {
            reader.seek(offset).await?;
            other.seek(offset).await?;
            while left > 0 {
                if cancel.is_some_and(|flag| flag.load(Ordering::SeqCst)) {
                    return Err(AppError::Ssh(CANCELLED.into()));
                }
                let n = left.min(CHUNK as u64) as usize;
                let mut got = 0;
                while got < n {
                    let read = reader.read(&mut a[got..n]).await?;
                    if read == 0 {
                        return Err(AppError::validation("sftp.resumePrefixMismatch"));
                    }
                    got += read;
                }
                let mut got = 0;
                while got < n {
                    let read = other.read(&mut b[got..n]).await?;
                    if read == 0 {
                        return Err(AppError::validation("sftp.resumePrefixMismatch"));
                    }
                    got += read;
                }
                if a[..n] != b[..n] {
                    return Err(AppError::validation("sftp.resumePrefixMismatch"));
                }
                left -= n as u64;
            }
            Ok(())
        }
        .await;
        let closed = other.finish().await;
        result?;
        closed
    })
    .await
}

pub(super) async fn fingerprint_file(
    endpoint: &Endpoint,
    sftp: Option<&SftpSession>,
    cancel: &AtomicBool,
) -> AppResult<BackupFingerprint> {
    interruptible(Some(cancel), async {
        let before = source_stamp(endpoint, sftp).await?;
        let mut reader = open_reader(endpoint, sftp).await?;
        let result = async {
            let mut hash = Sha256::new();
            let mut buf = vec![0; CHUNK];
            loop {
                if cancel.load(Ordering::SeqCst) {
                    return Err(AppError::Ssh(CANCELLED.into()));
                }
                let n = reader.read(&mut buf).await?;
                if n == 0 {
                    break;
                }
                hash.update(&buf[..n]);
            }
            Ok(format!("{:x}", hash.finalize()))
        }
        .await;
        let closed = reader.finish().await;
        let digest = result?;
        closed?;
        if source_stamp(endpoint, sftp).await? != before {
            return Err(AppError::validation("sftp.resumeSourceChanged"));
        }
        Ok((before.0, before.1, digest))
    })
    .await
}
