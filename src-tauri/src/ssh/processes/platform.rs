//! Select commands for the SSH server, independently of the desktop OS.
use base64::Engine;
use tauri::{AppHandle, Manager};

use super::super::monitor::exec;
use super::{BASE_SCRIPT, OPTIONAL_SCRIPT};
use crate::{
    error::{AppError, AppResult},
    state::AppState,
};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(in crate::ssh) enum Platform {
    #[default]
    Linux,
    Macos,
    Windows,
}

impl Platform {
    pub(in crate::ssh) fn script(self, optional: bool) -> String {
        match self {
            Self::Linux => format!(
                "{BASE_SCRIPT}\n{}",
                if optional { OPTIONAL_SCRIPT } else { "" }
            ),
            Self::Macos => include_str!("macos.sh").to_owned(),
            Self::Windows => powershell(include_str!("windows.ps1")),
        }
    }
}

pub(in crate::ssh) async fn detect(app: &AppHandle, session: &str) -> AppResult<Platform> {
    let state = app.state::<AppState>();
    if let Some(platform) = state
        .monitor
        .platforms
        .lock()
        .map_err(|_| AppError::internal("monitor.lock"))?
        .get(session)
        .copied()
    {
        return Ok(platform);
    }
    let name = exec(app, session, "uname -s").await?;
    let platform = match name.trim() {
        "Linux" => Platform::Linux,
        "Darwin" => Platform::Macos,
        _ => {
            let output = exec(
                app,
                session,
                &powershell(
                    "if ($env:OS -eq 'Windows_NT') { [Console]::Write('TUNNELDE_WINDOWS') }",
                ),
            )
            .await?;
            if output.trim() != "TUNNELDE_WINDOWS" {
                return Err(AppError::Ssh("monitor.processUnsupported".into()));
            }
            Platform::Windows
        }
    };
    state
        .monitor
        .platforms
        .lock()
        .map_err(|_| AppError::internal("monitor.lock"))?
        .insert(session.to_owned(), platform);
    Ok(platform)
}

pub(in crate::ssh) fn powershell(script: &str) -> String {
    let bytes: Vec<_> = script.encode_utf16().flat_map(u16::to_le_bytes).collect();
    let encoded = base64::engine::general_purpose::STANDARD.encode(bytes);
    format!("powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand {encoded}")
}

pub(in crate::ssh) fn ps_literal(value: &str) -> String {
    format!("'{}'", value.replace('\'', "''"))
}
