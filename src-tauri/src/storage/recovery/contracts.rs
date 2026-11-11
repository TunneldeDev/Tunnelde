use crate::storage::{
    layout::Category,
    public::contracts::{Change, Location},
};
use serde::{Deserialize, Serialize};

pub(crate) use crate::storage::public::contracts::Observe;

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Action {
    Retry,
    Cancel,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Request {
    #[serde(deserialize_with = "crate::storage::public::contracts::revision")]
    pub revision: String,
    pub action: Action,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Pending {
    pub action: Direction,
    pub restart_requested: bool,
    pub changes: Vec<Change>,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Direction {
    Apply,
    Cancel,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum CopyKind {
    Previous,
    Archive,
}

#[derive(Clone, Serialize)]
pub(crate) struct RecordedCopy {
    pub category: Category,
    pub kind: CopyKind,
    pub path: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot {
    pub version: u8,
    pub revision: String,
    pub locations: Vec<Location>,
    pub pending: Option<Pending>,
    pub recorded_copies: Vec<RecordedCopy>,
    pub has_error: bool,
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
pub(crate) struct RequestResult {
    pub version: u8,
    pub outcome: &'static str,
    pub snapshot: Snapshot,
}
