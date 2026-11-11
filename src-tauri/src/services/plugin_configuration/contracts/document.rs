use super::schema::Declaration;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

pub type Values = BTreeMap<String, Value>;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Stored {
    pub revision: String,
    pub schema_version: u32,
    pub schema_digest: String,
    pub values: Values,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Status {
    Ready,
    MigrationRequired,
    Incompatible,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub schema: Declaration,
    pub schema_digest: String,
    pub revision: String,
    pub stored_version: Option<u32>,
    pub stored_digest: Option<String>,
    pub status: Status,
    pub values: Values,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Expected {
    pub expected_revision: String,
    pub schema_digest: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Update {
    pub expected_revision: String,
    pub schema_digest: String,
    pub values: Values,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Backup {
    pub id: String,
    pub created_at: String,
    pub reason: String,
    pub document: Stored,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackupRequest {
    pub expected_revision: String,
    pub schema_digest: String,
    pub backup_id: String,
}
