use russh_sftp::client::RawSftpSession;
use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::db;
use crate::error::{AppError, AppResult};
use crate::ssh::session::{disconnect, review::Target, SshConnectRequest};
use crate::state::AppState;

mod authorized;
mod keypair;
use keypair::ensure_keypair;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledKey {
    pub public_key: String,
    pub key_path: String,
}

fn key_error(error: impl std::fmt::Display) -> AppError {
    AppError::Ssh(format!("ssh.keyError: {error}"))
}

async fn append_authorized(
    app: &AppHandle,
    session_id: &str,
    public: &str,
    target: &Target,
) -> AppResult<bool> {
    let handle = app.state::<AppState>().ssh.handle(session_id)?;
    let channel = handle
        .channel_open_session()
        .await
        .map_err(|error| AppError::Ssh(format!("sftp.channel: {error}")))?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|error| AppError::Ssh(format!("sftp.subsystem: {error}")))?;
    // Dropping this private raw session closes its stream and outstanding
    // handles, including cancellation/error paths. WRITE and CLOSE statuses
    // themselves must be acknowledged before the host's auth settings change.
    let sftp = RawSftpSession::new(channel.into_stream());
    sftp.init().await.map_err(key_error)?;
    authorized::append(&sftp, public, || target.verify_background(app)).await
}

/// Authenticates with the password the user just typed, appends the public key
/// to `authorized_keys`, then switches the host to key authentication.
pub async fn install(
    app: &AppHandle,
    host_id: &str,
    password: Option<String>,
    jump_credentials: std::collections::HashMap<String, super::session::HopCredential>,
) -> AppResult<InstalledKey> {
    let host = app
        .state::<AppState>()
        .db
        .with(|conn| db::hosts::find_host(conn, host_id))?;
    let captured_app = app.clone();
    let target =
        crate::services::credentials::inspect(move || Target::from_displayed(&captured_app, &host))
            .await?;
    install_target(app, target, password, jump_credentials).await
}

/// A cancelled/failed key setup never leaves its private SSH session registered.
struct SetupSession<'a> {
    app: &'a AppHandle,
    id: String,
}
impl Drop for SetupSession<'_> {
    fn drop(&mut self) {
        let _ = disconnect(self.app, &self.id);
    }
}

pub(crate) async fn install_target(
    app: &AppHandle,
    target: Target,
    password: Option<String>,
    jump_credentials: std::collections::HashMap<String, super::session::HopCredential>,
) -> AppResult<InstalledKey> {
    let host_id = target.host_id().to_owned();
    let directory = app
        .state::<AppState>()
        .storage
        .dir(crate::storage::layout::Category::Keys)
        .to_owned();
    let preparing_app = app.clone();
    let (target, (path, public)) = crate::services::credentials::checked(move |job| {
        // No database guard spans OS proxy reads or filesystem/key generation.
        // Local key publication is distinct from the later remote/DB effects.
        target.verify(&preparing_app)?;
        preparing_app
            .state::<AppState>()
            .db
            .with(|conn| db::hosts::find_host(conn, target.host_id()))?;
        job.commit()?;
        let pair = ensure_keypair(&directory)?;
        Ok((target, pair))
    })
    .await?;

    let session = target
        .connect(
            app.clone(),
            SshConnectRequest {
                jump_credentials,
                host_id: host_id.clone(),
                background: true,
                purpose: None,
                password,
                passphrase: None,
                cols: 80,
                rows: 24,
            },
            true,
            false,
        )
        .await?;

    let session = SetupSession {
        app,
        id: session.id,
    };
    append_authorized(app, &session.id, &public, &target).await?;

    let key_path = path.to_string_lossy().into_owned();
    let committing_app = app.clone();
    let committing_path = key_path.clone();
    crate::services::credentials::checked(move |job| {
        // with_current performs slow transport inspection before taking the
        // short DB guard, then validates the ORIGINAL captured configuration.
        target.with_current(&committing_app, |conn| {
            job.commit()?;
            db::hosts::set_key_auth(conn, &host_id, &committing_path)
        })
    })
    .await?;

    Ok(InstalledKey {
        public_key: public,
        key_path,
    })
}
