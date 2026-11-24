//! User fonts are runtime data, never bundled application assets.
mod commands;
mod protocol;
mod repository;

pub(crate) use commands::*;
pub(crate) use protocol::{capacity, serve};

use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, sync::Mutex};

pub(super) const MAX_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "source", rename_all = "camelCase", deny_unknown_fields)]
pub enum FontReference {
    System { family: String },
    Imported { id: String },
}

impl FontReference {
    fn valid(&self) -> bool {
        match self {
            Self::System { family } => {
                !family.trim().is_empty()
                    && family.len() <= 1024
                    && family.chars().count() <= 256
                    && !family.chars().any(char::is_control)
            }
            Self::Imported { id } => valid_id(id),
        }
    }
}

pub(super) fn valid_id(id: &str) -> bool {
    id.len() == 64
        && id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default, deny_unknown_fields)]
pub struct FontSelections {
    pub ui: Option<FontReference>,
    pub mono: Option<FontReference>,
    pub editor_cjk: Option<FontReference>,
}

impl FontSelections {
    pub(crate) fn sanitize(&mut self) {
        for item in [&mut self.ui, &mut self.mono, &mut self.editor_cjk] {
            if item.as_ref().is_some_and(|value| !value.valid()) {
                *item = None;
            }
        }
    }
    fn without(&mut self, id: &str) {
        for item in [&mut self.ui, &mut self.mono, &mut self.editor_cjk] {
            if matches!(item, Some(FontReference::Imported { id: value }) if value == id) {
                *item = None;
            }
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FontInfo {
    pub reference: FontReference,
    pub name: String,
    pub monospaced: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub format: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes: Option<u64>,
}

#[derive(Serialize)]
pub(crate) struct FontCatalogue {
    version: u8,
    items: Vec<FontInfo>,
}

#[derive(Debug, Serialize)]
pub(crate) struct FontImport {
    token: String,
    font: FontInfo,
}

pub(super) struct Staged {
    directory: std::path::PathBuf,
    font: FontInfo,
    created: std::time::Instant,
}

#[derive(Default)]
pub(crate) struct Registry {
    systems: Mutex<Option<Vec<FontInfo>>>,
    staging: Mutex<HashMap<String, Staged>>,
    mutation: tokio::sync::Mutex<()>,
    initialized: std::sync::OnceLock<()>,
}

fn invalid() -> AppError {
    AppError::validation("fonts.invalidFile")
}

pub(crate) async fn catalogue(app: &tauri::AppHandle, refresh: bool) -> AppResult<FontCatalogue> {
    use crate::services::operations::{Budget, Errors};
    static WORKERS: std::sync::LazyLock<Budget> = std::sync::LazyLock::new(|| {
        Budget::new(
            2,
            Errors {
                domain: "fonts",
                busy: "fonts.busy",
                cancelled: "fonts.cancelled",
                failed: "fonts.unavailableError",
            },
        )
    });
    let app = app.clone();
    WORKERS
        .blocking(move |cancellation| {
            cancellation.check()?;
            let result = repository::catalogue(&app, refresh)?;
            cancellation.check()?;
            Ok(result)
        })
        .await
}

#[cfg(test)]
mod tests;
