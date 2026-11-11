use super::super::layout::Category;
use serde::{Deserialize, Serialize};

pub(crate) fn revision<'de, D: serde::Deserializer<'de>>(d: D) -> Result<String, D::Error> {
    let value = String::deserialize(d)?;
    if value.is_empty() || value.len() > 128 || value.chars().any(char::is_control) {
        return Err(serde::de::Error::custom("invalid revision"));
    }
    Ok(value)
}
fn optional_revision<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    revision(d).map(Some)
}
#[derive(Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Observe {
    #[serde(default, deserialize_with = "optional_revision")]
    pub revision: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Change {
    pub category: Category,
    pub target: String,
    pub migrate: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Schedule {
    #[serde(deserialize_with = "revision")]
    pub revision: String,
    pub changes: Vec<Change>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Cancel {
    #[serde(deserialize_with = "revision")]
    pub revision: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Location {
    pub category: Category,
    pub path: String,
    pub default_path: String,
    pub overridden: bool,
}
#[derive(Clone, Serialize)]
pub(crate) struct Plan {
    pub changes: Vec<Change>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot {
    pub version: u8,
    pub revision: String,
    pub locations: Vec<Location>,
    pub pending: Option<Plan>,
    pub recovery_required: bool,
}
#[derive(Serialize)]
pub(crate) struct Observation {
    pub version: u8,
    pub revision: String,
    pub changed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub snapshot: Option<Snapshot>,
}
#[derive(Serialize)]
pub(crate) struct ChangeResult {
    pub version: u8,
    pub outcome: &'static str,
    pub snapshot: Snapshot,
}
