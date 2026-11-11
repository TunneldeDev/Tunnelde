//! Positions are not capabilities. They never supply paths or authorization.
use super::contracts::{Request, MAX_SAFE};
use crate::error::{AppError, AppResult};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Default, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Position {
    pub file: Option<String>,
    pub offset: u64,
    pub anchor: String,
    pub discarding: bool,
    pub operation_id: u64,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    binding: String,
    position: Position,
}

pub fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
pub fn binding(owner: &str, request: &Request) -> AppResult<String> {
    static BOOT: std::sync::LazyLock<String> =
        std::sync::LazyLock::new(|| uuid::Uuid::new_v4().to_string());
    Ok(digest(&serde_json::to_vec(&(
        BOOT.as_str(),
        owner,
        request.source,
        &request.filter,
    ))?))
}
pub fn decode(value: Option<&str>, binding: &str) -> AppResult<Position> {
    let Some(value) = value else {
        return Ok(Position::default());
    };
    let invalid = || AppError::validation("logs.read.invalidCursor");
    if value.is_empty() || value.len() > 2048 {
        return Err(invalid());
    }
    let bytes = URL_SAFE_NO_PAD.decode(value).map_err(|_| invalid())?;
    let parsed: Cursor = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    let hex = |v: &str| v.len() == 64 && v.bytes().all(|b| b.is_ascii_hexdigit());
    if parsed.binding != binding
        || parsed.position.offset > MAX_SAFE
        || parsed.position.operation_id > MAX_SAFE
        || parsed.position.file.as_ref().is_some_and(|v| !hex(v))
        || (!parsed.position.anchor.is_empty() && !hex(&parsed.position.anchor))
    {
        return Err(invalid());
    }
    Ok(parsed.position)
}
pub fn encode(position: Position, binding: String) -> AppResult<String> {
    Ok(URL_SAFE_NO_PAD.encode(serde_json::to_vec(&Cursor { binding, position })?))
}
