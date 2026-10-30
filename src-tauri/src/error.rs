// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

use serde::ser::SerializeStruct;
use serde::{Serialize, Serializer};

/// Errors surfaced to the webview. Each variant maps to a stable `code`
/// so the frontend can localize messages instead of showing raw strings.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{0}")]
    Validation(String),
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Db(#[from] rusqlite::Error),
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Internal(String),
    #[error("{0}")]
    Update(String),
    #[error("{0}")]
    Ssh(String),
}

impl AppError {
    pub fn internal(message: impl Into<String>) -> Self {
        Self::Internal(message.into())
    }

    pub fn validation(message: impl Into<String>) -> Self {
        Self::Validation(message.into())
    }

    pub fn code(&self) -> &'static str {
        match self {
            Self::Validation(_) => "validation",
            Self::NotFound(_) => "notFound",
            Self::Db(_) => "database",
            Self::Io(_) => "io",
            Self::Internal(_) => "internal",
            Self::Update(_) => "update",
            Self::Ssh(_) => "ssh",
        }
    }
}

impl From<serde_json::Error> for AppError {
    fn from(value: serde_json::Error) -> Self {
        Self::Internal(format!("serialization failed: {value}"))
    }
}

impl From<tauri::Error> for AppError {
    fn from(value: tauri::Error) -> Self {
        Self::Internal(value.to_string())
    }
}

impl From<tauri_plugin_updater::Error> for AppError {
    fn from(value: tauri_plugin_updater::Error) -> Self {
        Self::Update(value.to_string())
    }
}

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        let mut state = serializer.serialize_struct("AppError", 2)?;
        state.serialize_field("code", self.code())?;
        state.serialize_field("message", &self.to_string())?;
        state.end()
    }
}

pub type AppResult<T> = Result<T, AppError>;
