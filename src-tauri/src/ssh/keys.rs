// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

use std::path::{Path, PathBuf};

use russh::keys::ssh_key::LineEnding;
use russh::keys::{Algorithm, PrivateKey};
use russh_sftp::client::SftpSession;
use russh_sftp::protocol::StatusCode;
use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::db;
use crate::error::{AppError, AppResult};
use crate::ssh::session::{connect_with_password, disconnect, SshConnectRequest};
use crate::state::AppState;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledKey {
    pub public_key: String,
    pub key_path: String,
}

fn key_error(error: impl std::fmt::Display) -> AppError {
    AppError::Ssh(format!("ssh.keyError: {error}"))
}

/// Tunnelde keeps one dedicated key pair under its data folder. It is created
/// on first use and never leaves the machine except as the public half.
fn ensure_keypair(data_dir: &Path) -> AppResult<(PathBuf, String)> {
    let directory = data_dir.join("keys");
    std::fs::create_dir_all(&directory)?;
    let private = directory.join("tunnelde_ed25519");

    if !private.exists() {
        let key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).map_err(key_error)?;
        let pem = key.to_openssh(LineEnding::LF).map_err(key_error)?;
        std::fs::write(&private, pem.as_bytes())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&private, std::fs::Permissions::from_mode(0o600));
        }
    }

    let key = russh::keys::load_secret_key(&private, None).map_err(key_error)?;
    let public = key.public_key().to_openssh().map_err(key_error)?;
    Ok((private, public.trim().to_string()))
}

/// Adds the line to the file content unless it is already there.
fn merge_authorized(existing: &str, public: &str) -> Option<String> {
    let line = public.trim();
    if line.is_empty() || existing.lines().any(|entry| entry.trim() == line) {
        return None;
    }
    let mut next = existing.to_string();
    if !next.is_empty() && !next.ends_with('\n') {
        next.push('\n');
    }
    next.push_str(line);
    next.push('\n');
    Some(next)
}

fn authorized_contents(
    result: Result<Vec<u8>, russh_sftp::client::error::Error>,
) -> AppResult<String> {
    match result {
        Ok(bytes) => String::from_utf8(bytes).map_err(key_error),
        Err(russh_sftp::client::error::Error::Status(status))
            if status.status_code == StatusCode::NoSuchFile =>
        {
            Ok(String::new())
        }
        Err(error) => Err(key_error(error)),
    }
}

async fn append_authorized(app: &AppHandle, session_id: &str, public: &str) -> AppResult<bool> {
    let handle = app.state::<AppState>().ssh.handle(session_id)?;
    let channel = handle
        .channel_open_session()
        .await
        .map_err(|error| AppError::Ssh(format!("sftp.channel: {error}")))?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|error| AppError::Ssh(format!("sftp.subsystem: {error}")))?;
    let sftp = SftpSession::new(channel.into_stream())
        .await
        .map_err(|error| AppError::Ssh(format!("sftp.error: {error}")))?;

    let home = sftp.canonicalize(".").await.unwrap_or_else(|_| ".".into());
    let directory = format!("{}/.ssh", home.trim_end_matches('/'));
    let _ = sftp.create_dir(&directory).await;
    let file = format!("{directory}/authorized_keys");
    let existing = authorized_contents(sftp.read(&file).await)?;

    let mut written = false;
    if let Some(next) = merge_authorized(&existing, public) {
        sftp.write(&file, next.as_bytes())
            .await
            .map_err(|error| AppError::Ssh(format!("sftp.error: {error}")))?;
        written = true;
    }

    let _ = sftp.close().await;
    Ok(written)
}

/// Authenticates with the password the user just typed, appends the public key
/// to `authorized_keys`, then switches the host to key authentication.
pub async fn install(
    app: &AppHandle,
    host_id: &str,
    password: Option<String>,
) -> AppResult<InstalledKey> {
    let state = app.state::<AppState>();
    state.db.with(|conn| db::hosts::find_host(conn, host_id))?;
    let (path, public) = ensure_keypair(&state.data_dir)?;

    let session = connect_with_password(
        app.clone(),
        SshConnectRequest {
            host_id: host_id.to_string(),
            password,
            passphrase: None,
            cols: 80,
            rows: 24,
        },
    )
    .await?;

    let outcome = append_authorized(app, &session.id, &public).await;
    let _ = disconnect(app, &session.id);
    outcome?;

    let key_path = path.to_string_lossy().into_owned();
    state
        .db
        .with(|conn| db::hosts::set_key_auth(conn, host_id, &key_path))?;

    Ok(InstalledKey {
        public_key: public,
        key_path,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const LINE: &str = "ssh-ed25519 AAAAC3Nza tunnelde";

    #[test]
    fn appends_a_missing_key() {
        assert_eq!(
            merge_authorized("", LINE),
            Some("ssh-ed25519 AAAAC3Nza tunnelde\n".into())
        );
        assert_eq!(
            merge_authorized("ssh-rsa AAAA other", LINE),
            Some("ssh-rsa AAAA other\nssh-ed25519 AAAAC3Nza tunnelde\n".into())
        );
    }

    #[test]
    fn skips_an_existing_key() {
        assert_eq!(merge_authorized(LINE, LINE), None);
        assert_eq!(
            merge_authorized("ssh-rsa AAAA other\nssh-ed25519 AAAAC3Nza tunnelde\n", LINE),
            None
        );
    }

    #[test]
    fn only_a_missing_authorized_file_is_treated_as_empty() {
        use russh_sftp::client::error::Error;
        use russh_sftp::protocol::Status;

        let status = |status_code| {
            Error::Status(Status {
                id: 0,
                status_code,
                error_message: String::new(),
                language_tag: String::new(),
            })
        };
        assert_eq!(
            authorized_contents(Err(status(StatusCode::NoSuchFile))).unwrap(),
            ""
        );
        assert!(authorized_contents(Err(status(StatusCode::PermissionDenied))).is_err());
        assert!(authorized_contents(Err(Error::Timeout)).is_err());
        assert!(authorized_contents(Ok(vec![0xff])).is_err());
        assert_eq!(
            authorized_contents(Ok(b"existing key\n".to_vec())).unwrap(),
            "existing key\n"
        );
    }
}
