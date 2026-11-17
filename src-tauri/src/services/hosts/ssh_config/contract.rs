use serde::{Deserialize, Serialize};

use crate::models::HostInput;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum IssueCode {
    ReadFailed,
    TooLarge,
    InvalidLine,
    UnsupportedOption,
    InvalidValue,
    MissingJump,
    ExistingConflict,
    IncludeCycle,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    pub code: IssueCode,
    pub detail: String,
}

impl Issue {
    pub(super) fn new(code: IssueCode, detail: impl Into<String>) -> Self {
        Self {
            code,
            detail: detail.into(),
        }
    }
}

/// IPC shape of a validated host input. Kept local so preview serialization
/// never exposes parser internals or imports unrelated model modules.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryInput {
    pub name: String,
    pub group_id: Option<String>,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: String,
    pub key_path: Option<String>,
    pub favorite: bool,
    pub color: Option<String>,
    pub tags: Vec<String>,
    pub note: Option<String>,
}

impl EntryInput {
    pub(super) fn into_host_input(self) -> HostInput {
        HostInput {
            name: self.name,
            group_id: self.group_id,
            host: self.host,
            port: Some(self.port),
            username: Some(self.username),
            auth_method: Some(self.auth_method),
            key_path: self.key_path,
            favorite: self.favorite,
            color: self.color,
            tags: self.tags,
            note: self.note,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub alias: String,
    pub input: Option<EntryInput>,
    pub jump_aliases: Vec<String>,
    pub issues: Vec<Issue>,
    pub existing_id: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    pub path: String,
    pub found: bool,
    pub revision: String,
    pub entries: Vec<Entry>,
    pub issues: Vec<Issue>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub imported: Vec<crate::models::Host>,
    pub skipped: usize,
}
