//! Versioned wire envelopes. Internal Settings and persistence keys are private.
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot {
    pub version: u8,
    pub revision: String,
    pub values: Value,
    pub defaults: Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Schema {
    pub version: u8,
    pub stability: &'static str,
    pub groups: Value,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Update {
    pub revision: String,
    pub changes: Value,
}
