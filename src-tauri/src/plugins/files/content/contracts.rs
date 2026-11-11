use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};

pub const MAX_CHUNK: u64 = 48 * 1024;
pub const MAX_SAFE_INTEGER: u64 = (1_u64 << 53) - 1;
pub const PREPARED_MS: u64 = 20_000;
pub const IDLE_MS: u64 = 60_000;

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Endpoint {
    Local {},
    Remote {
        #[serde(rename = "sessionId")]
        session_id: String,
    },
}
impl Endpoint {
    pub fn permission(&self) -> &'static str {
        match self {
            Self::Local {} => "fs.read",
            Self::Remote { .. } => "sftp.read",
        }
    }
    pub fn session(&self) -> Option<&str> {
        match self {
            Self::Local {} => None,
            Self::Remote { session_id } => Some(session_id),
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Prepare {
    pub source: Endpoint,
    pub path: String,
}
impl Prepare {
    pub fn validate(&self) -> AppResult<()> {
        if self.path.is_empty() || self.path.len() > 32768 || self.path.contains('\0') {
            return Err(invalid());
        }
        let absolute = match &self.source {
            Endpoint::Local {} => std::path::Path::new(&self.path).is_absolute(),
            Endpoint::Remote { session_id } => {
                !session_id.is_empty()
                    && session_id.len() <= 128
                    && !session_id.chars().any(char::is_control)
                    && self.path.starts_with('/')
            }
        };
        if !absolute {
            return Err(invalid());
        }
        Ok(())
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Reference {
    pub content_id: String,
}
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Read {
    pub content_id: String,
    pub offset: u64,
    pub length: u64,
}
impl Read {
    pub fn validate(&self) -> AppResult<()> {
        id(&self.content_id)?;
        if self.length == 0 || self.length > MAX_CHUNK || self.offset > MAX_SAFE_INTEGER {
            return Err(invalid());
        }
        Ok(())
    }
}
pub fn id(value: &str) -> AppResult<()> {
    if !uuid::Uuid::parse_str(value).is_ok_and(|id| id.to_string() == value) {
        return Err(invalid());
    }
    Ok(())
}
pub fn invalid() -> AppError {
    AppError::validation("plugin.fileContent.invalid")
}
pub fn unavailable() -> AppError {
    AppError::validation("plugin.fileContent.unavailable")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Phase {
    Prepared,
    Opening,
    Open,
    Closed,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Prepared {
    pub version: u8,
    pub content_id: String,
    pub lease_ms: u64,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Observation {
    pub version: u8,
    pub content_id: String,
    pub state: Phase,
    pub size: Option<u64>,
    pub chunk_bytes: u64,
    pub lease_ms: u64,
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Chunk {
    pub version: u8,
    pub content_id: String,
    pub offset: u64,
    pub bytes: usize,
    pub data: String,
    pub eof: bool,
}
