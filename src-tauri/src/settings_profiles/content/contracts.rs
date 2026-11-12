//! Experimental public wire DTOs. Offsets and limits count UTF-8 bytes, not characters.
use super::MAX_CHUNK_BYTES;
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
#[serde(try_from = "serde_json::Map<String, serde_json::Value>")]
pub(crate) struct Empty {}

impl TryFrom<serde_json::Map<String, serde_json::Value>> for Empty {
    type Error = &'static str;
    fn try_from(fields: serde_json::Map<String, serde_json::Value>) -> Result<Self, Self::Error> {
        if fields.is_empty() {
            Ok(Self {})
        } else {
            Err("unknown profile catalogue field")
        }
    }
}

#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Read {
    pub id: String,
    pub revision: String,
    pub offset: usize,
    pub limit: usize,
}

impl Read {
    pub(super) fn validate(&self) -> AppResult<()> {
        if self.id.is_empty()
            || self.id.len() > 128
            || self.id.chars().any(char::is_control)
            || self.revision.len() != 68
            || !self.revision.starts_with("pc1:")
            || !self.revision[4..]
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            || self.offset > super::MAX_CONTENT_BYTES
            || !(4..=MAX_CHUNK_BYTES).contains(&self.limit)
        {
            return Err(AppError::validation("profiles.content.invalidRequest"));
        }
        Ok(())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Catalogue {
    pub version: u8,
    /// Content revision, separate from the historical metadata-only p1 token.
    pub revision: String,
    /// Last explicitly selected native profile, not a claim of content equality.
    pub active_id: Option<String>,
    pub items: Vec<super::super::observation::contracts::Metadata>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Chunk {
    pub version: u8,
    pub id: String,
    pub revision: String,
    pub offset: usize,
    pub total_bytes: usize,
    pub text: String,
    pub next_offset: Option<usize>,
}
