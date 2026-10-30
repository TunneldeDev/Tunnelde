// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

pub const API_VERSION: u32 = 1;
pub const MANIFEST_FILE: &str = "tunnelde-plugin.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginCommand {
    pub id: String,
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    pub api_version: u32,
    pub main: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub commands: Vec<PluginCommand>,
    #[serde(default)]
    pub permissions: Vec<String>,
}

pub fn load(dir: &Path) -> AppResult<PluginManifest> {
    let path = dir.join(MANIFEST_FILE);
    let raw = std::fs::read_to_string(&path)
        .map_err(|error| AppError::Validation(format!("plugin.manifest.unreadable: {error}")))?;
    let manifest: PluginManifest = serde_json::from_str(&raw)
        .map_err(|error| AppError::Validation(format!("plugin.manifest.invalid: {error}")))?;
    manifest.validate(dir)?;
    Ok(manifest)
}

impl PluginManifest {
    fn validate(&self, dir: &Path) -> AppResult<()> {
        if !valid_id(&self.id) {
            return Err(AppError::validation("plugin.id.invalid"));
        }
        if self.name.trim().is_empty() {
            return Err(AppError::validation("plugin.name.required"));
        }
        if self.api_version != API_VERSION {
            return Err(AppError::validation("plugin.apiVersion.unsupported"));
        }
        if !matches!(self.version.split('.').count(), 2 | 3) {
            return Err(AppError::validation("plugin.version.invalid"));
        }
        for command in &self.commands {
            if !valid_id(&command.id) || command.title.trim().is_empty() {
                return Err(AppError::validation("plugin.command.invalid"));
            }
        }
        for permission in &self.permissions {
            if permission != "log" {
                return Err(AppError::validation("plugin.permission.unknown"));
            }
        }
        entry_path(dir, &self.main)?;
        Ok(())
    }
}

/// Resolves the entry script and refuses anything outside the plugin folder.
pub fn entry_path(dir: &Path, main: &str) -> AppResult<PathBuf> {
    let root = dir
        .canonicalize()
        .map_err(|error| AppError::Validation(format!("plugin.path: {error}")))?;
    let entry = root.join(main);
    let entry = entry
        .canonicalize()
        .map_err(|error| AppError::Validation(format!("plugin.entry.missing: {error}")))?;
    if !entry.starts_with(&root) {
        return Err(AppError::validation("plugin.entry.outside"));
    }
    Ok(entry)
}

fn valid_id(value: &str) -> bool {
    let mut chars = value.chars();
    match chars.next() {
        Some(first) if first.is_ascii_lowercase() || first.is_ascii_digit() => {}
        _ => return false,
    }
    value.len() <= 64
        && chars.all(|character| {
            character.is_ascii_lowercase()
                || character.is_ascii_digit()
                || character == '-'
                || character == '_'
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(dir: &Path, main: &str) -> PluginManifest {
        let payload = format!(
            r#"{{"id":"hello","name":"Hello","version":"0.1.0","apiVersion":1,"main":"{main}"}}"#
        );
        std::fs::write(dir.join(MANIFEST_FILE), payload).expect("manifest");
        load(dir).expect("valid manifest")
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("tunnelde-plugin-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    #[test]
    fn accepts_a_minimal_manifest() {
        let dir = temp_dir("minimal");
        std::fs::write(dir.join("index.js"), "").expect("entry");
        let manifest = write(&dir, "index.js");
        assert_eq!(manifest.id, "hello");
        assert_eq!(manifest.api_version, 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_missing_entry() {
        let dir = temp_dir("missing");
        let payload =
            r#"{"id":"hello","name":"Hello","version":"0.1.0","apiVersion":1,"main":"missing.js"}"#;
        std::fs::write(dir.join(MANIFEST_FILE), payload).expect("manifest");
        assert!(load(&dir).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_escaping_entry() {
        let dir = temp_dir("escape");
        let payload =
            r#"{"id":"hello","name":"Hello","version":"0.1.0","apiVersion":1,"main":"../evil.js"}"#;
        std::fs::write(dir.join(MANIFEST_FILE), payload).expect("manifest");
        assert!(load(&dir).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_bad_ids_and_permissions() {
        let dir = temp_dir("ids");
        std::fs::write(dir.join("index.js"), "").expect("entry");
        let payload = r#"{"id":"Bad Id","name":"x","version":"1.0.0","apiVersion":1,"main":"index.js","permissions":["shell"]}"#;
        std::fs::write(dir.join(MANIFEST_FILE), payload).expect("manifest");
        assert!(load(&dir).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
