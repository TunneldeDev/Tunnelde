//! Public mutation DTOs. Revisions are opaque fences; IDs grant no authority.
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Deserializer, Serialize};

pub(super) fn invalid() -> AppError {
    AppError::validation("profiles.mutation.invalidRequest")
}
pub(crate) fn revision(value: &str) -> AppResult<()> {
    if value.len() == 68
        && value.starts_with("pc1:")
        && value[4..]
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        Ok(())
    } else {
        Err(invalid())
    }
}
pub(crate) fn id(value: &str) -> AppResult<()> {
    if value.is_empty() || value.len() > 128 || value.chars().any(char::is_control) {
        Err(invalid())
    } else {
        Ok(())
    }
}
fn optional_id<'de, D: Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    String::deserialize(d).map(Some)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Prepare {
    pub revision: String,
    pub total_bytes: usize,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Append {
    pub draft_id: String,
    pub offset: usize,
    pub text: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Discard {
    pub draft_id: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Save {
    pub revision: String,
    pub draft_id: String,
    pub name: String,
    #[serde(default, deserialize_with = "optional_id")]
    pub id: Option<String>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Rename {
    pub id: String,
    pub revision: String,
    pub name: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Delete {
    pub id: String,
    pub revision: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Activate {
    pub id: String,
    pub revision: String,
    pub preferences_revision: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Draft {
    pub version: u8,
    pub draft_id: String,
    pub total_bytes: usize,
    pub offset: usize,
}
#[derive(Serialize)]
pub(crate) struct Changed {
    pub version: u8,
    pub id: String,
    pub revision: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Activated {
    pub version: u8,
    pub id: String,
    pub revision: String,
    pub preferences_revision: String,
}
