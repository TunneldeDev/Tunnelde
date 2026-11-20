//! Append one public key, preserving bytes appended by another SSH client.
use super::key_error;
use crate::error::{AppError, AppResult};
use russh_sftp::{
    client::{error::Error, RawSftpSession},
    protocol::{FileAttributes, OpenFlags, StatusCode},
};
use std::future::Future;

const MAX_CONTENTS: usize = 4 * 1024 * 1024;

fn status(error: &Error, code: StatusCode) -> bool {
    matches!(error, Error::Status(value) if value.status_code == code)
}

fn error(stage: &str, error: impl std::fmt::Display) -> AppError {
    key_error(format!("authorized_keys {stage}: {error}"))
}

async fn directory<F: Future<Output = AppResult<()>>>(
    sftp: &RawSftpSession,
    path: &str,
    current: &impl Fn() -> F,
) -> AppResult<()> {
    match sftp.stat(path).await {
        Ok(metadata) if metadata.attrs.is_dir() => return Ok(()),
        Ok(_) => return Err(error("directory", ".ssh is not a directory")),
        Err(failure) if status(&failure, StatusCode::NoSuchFile) => {}
        Err(failure) => return Err(error("directory inspection", failure)),
    }
    current().await?;
    if let Err(failure) = sftp
        .mkdir(
            path,
            FileAttributes {
                permissions: Some(0o700),
                ..Default::default()
            },
        )
        .await
    {
        // SFTP v3 has no consistent AlreadyExists status. A competing setup
        // may have created the directory; only an actual directory is usable.
        if !sftp
            .stat(path)
            .await
            .is_ok_and(|attrs| attrs.attrs.is_dir())
        {
            return Err(error("directory creation", failure));
        }
    }
    Ok(())
}

async fn contents(sftp: &RawSftpSession, path: &str) -> AppResult<String> {
    let handle = match sftp
        .open(path, OpenFlags::READ, FileAttributes::empty())
        .await
    {
        Ok(handle) => handle.handle,
        Err(failure) if status(&failure, StatusCode::NoSuchFile) => return Ok(String::new()),
        Err(failure) => return Err(error("read open", failure)),
    };
    let reading = async {
        let mut bytes = Vec::new();
        loop {
            match sftp.read(&handle, bytes.len() as u64, 32 * 1024).await {
                Ok(data) if data.data.is_empty() => break,
                Ok(data) => {
                    if data.data.len() > MAX_CONTENTS - bytes.len() {
                        return Err(error("read", "file exceeds 4 MiB safety limit"));
                    }
                    bytes.extend_from_slice(&data.data);
                }
                Err(failure) if status(&failure, StatusCode::Eof) => break,
                Err(failure) => return Err(error("read", failure)),
            }
        }
        String::from_utf8(bytes).map_err(|failure| error("decode", failure))
    }
    .await;
    let closing = sftp
        .close(handle)
        .await
        .map_err(|failure| error("read close", failure));
    let result = reading?;
    closing?;
    Ok(result)
}

pub(super) async fn append<F: Future<Output = AppResult<()>>>(
    sftp: &RawSftpSession,
    public: &str,
    current: impl Fn() -> F,
) -> AppResult<bool> {
    let home = sftp
        .realpath(".")
        .await
        .map_err(|failure| error("home", failure))?;
    let home = home
        .files
        .first()
        .ok_or_else(|| error("home", "empty server response"))?;
    let directory_path = format!("{}/.ssh", home.filename.trim_end_matches('/'));
    current().await?;
    directory(sftp, &directory_path, &current).await?;
    let path = format!("{directory_path}/authorized_keys");
    let existing = contents(sftp, &path).await?;
    let public = public.trim();
    if public.is_empty() || public.contains(['\n', '\r']) {
        return Err(error("public key", "expected one nonempty line"));
    }
    if existing.lines().any(|line| line.trim() == public) {
        return Ok(false);
    }
    current().await?;
    let handle = sftp
        .open(
            &path,
            OpenFlags::WRITE | OpenFlags::APPEND | OpenFlags::CREATE,
            FileAttributes {
                permissions: Some(0o600),
                ..Default::default()
            },
        )
        .await
        .map_err(|failure| error("append open", failure))?
        .handle;
    // APPEND makes the server select EOF at the actual write. A leading LF
    // separates a concurrent append that did not end with one, even if our
    // earlier read observed an empty/missing file. No old contents are resent.
    let writing = async {
        // APPEND/CREATE admission does not authorize a later WRITE after a
        // slow open. A rejection still closes this exact admitted handle.
        current().await?;
        sftp.write(&handle, 0, format!("\n{public}\n").into_bytes())
            .await
            .map_err(|failure| error("append", failure))
    }
    .await;
    let closing = sftp
        .close(handle)
        .await
        .map_err(|failure| error("append close", failure));
    writing?;
    closing?;
    Ok(true)
}

#[cfg(test)]
mod tests;
