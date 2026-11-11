//! Native-only metadata DTOs. No paths, admission tokens, arbitrary names or content.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Deserialize, Serialize)]
pub(crate) enum Name {
    #[serde(rename = "pid")]
    Pid,
    #[serde(rename = "heartbeat")]
    Heartbeat,
    #[serde(rename = "STOP")]
    Stop,
    #[serde(rename = "status.json")]
    Status,
    #[serde(rename = "events.jsonl")]
    Events,
    #[serde(rename = "events.previous.jsonl")]
    PreviousEvents,
    #[serde(rename = "approvals.json")]
    Approvals,
    #[serde(rename = "storage.json")]
    Storage,
    #[serde(rename = "inbox")]
    Inbox,
}

#[derive(Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Kind {
    File,
    Directory,
    Link,
    Other,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Artifact {
    pub name: Name,
    pub kind: Kind,
    #[serde(deserialize_with = "nullable")]
    pub size_bytes: Option<String>,
}

pub(super) fn nullable<'de, D, T>(deserializer: D) -> std::result::Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

#[derive(Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Admission {
    Reserved,
    Launched,
    Cancelled,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum SnapshotReason {
    AdmissionUnavailable,
    UnsafeDirectory,
    NamespaceChanged,
    EnumerationLimit,
    MetadataUnavailable,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "status", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum Snapshot {
    Missing {},
    Present {
        entries: Vec<Artifact>,
        #[serde(rename = "otherEntries")]
        other_entries: usize,
    },
    Unavailable {
        reason: SnapshotReason,
    },
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum UnsupportedReason {
    LegacyTask,
    HelperCapability,
}

#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub(crate) enum Result {
    Observed {
        admission: Option<Admission>,
        consistency: &'static str,
        #[serde(rename = "cleanupAuthorized")]
        cleanup_authorized: bool,
        snapshot: Snapshot,
    },
    Unsupported {
        reason: UnsupportedReason,
    },
    Unavailable {
        reason: super::super::capabilities::contracts::Reason,
        #[serde(rename = "exitCode", skip_serializing_if = "Option::is_none")]
        exit_code: Option<u32>,
    },
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Observation {
    pub token: String,
    pub checked_at: i64,
    pub result: Result,
}
