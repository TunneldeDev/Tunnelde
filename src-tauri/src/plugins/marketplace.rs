// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};

use crate::error::{AppError, AppResult};
use crate::plugins::PluginInfo;
use crate::state::AppState;

const MAX_ARCHIVE: usize = 64 * 1024 * 1024;

pub fn digest(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Installs an archive that the webview downloaded. The checksum pinned in the
/// catalogue must match, so a tampered download is refused before unpacking.
pub async fn install_archive(
    app: &AppHandle,
    id: &str,
    sha256: &str,
    data: &str,
) -> AppResult<PluginInfo> {
    if id.trim().is_empty() || id.len() > 64 {
        return Err(AppError::validation("marketplace.invalidId"));
    }
    if sha256.len() != 64 || !sha256.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(AppError::validation("marketplace.invalidChecksum"));
    }
    if data.len() > MAX_ARCHIVE * 4 / 3 + 4 {
        return Err(AppError::validation("plugin.archive.tooLarge"));
    }

    let bytes = BASE64
        .decode(data)
        .map_err(|_| AppError::validation("marketplace.invalidArchive"))?;
    if bytes.is_empty() || bytes.len() > MAX_ARCHIVE {
        return Err(AppError::validation("plugin.archive.tooLarge"));
    }
    let actual = digest(&bytes);
    if !actual.eq_ignore_ascii_case(sha256) {
        return Err(AppError::validation("marketplace.checksumMismatch"));
    }

    let state = app.state::<AppState>();
    let directory = state.data_dir.join("tmp");
    std::fs::create_dir_all(&directory)?;
    let path = directory.join(format!("{id}-{}.zip", uuid::Uuid::new_v4()));
    std::fs::write(&path, &bytes)?;
    let outcome = state.plugins.install(path.to_string_lossy().as_ref()).await;
    let _ = std::fs::remove_file(&path);
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn digest_is_hex_sha256() {
        let value = digest(b"abc");
        assert_eq!(value.len(), 64);
        assert!(value.bytes().all(|byte| byte.is_ascii_hexdigit()));
        // Known SHA-256 of "abc".
        assert_eq!(
            value,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }
}
