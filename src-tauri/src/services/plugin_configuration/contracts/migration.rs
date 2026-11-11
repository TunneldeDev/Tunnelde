use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Migration {
    pub from_version: u32,
    pub from_digest: String,
    pub to_version: u32,
    pub to_digest: String,
    pub operations: Vec<Operation>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "camelCase", deny_unknown_fields)]
pub enum Operation {
    Rename { from: String, to: String },
    SetDefault { key: String, value: Value },
    Remove { key: String },
}
