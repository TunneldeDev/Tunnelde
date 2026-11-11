use super::contracts::{Admission, Kind, Result, Snapshot, SnapshotReason};
use crate::plugins::runners::Record;
use serde::Deserialize;
use std::collections::HashSet;

pub(super) const MAX_OUTPUT: usize = 16384;
pub(super) const MAX_ENTRIES: usize = 256;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Receipt {
    schema_version: u32,
    runner_id: String,
    token: String,
    observation_id: String,
    #[serde(deserialize_with = "super::contracts::nullable")]
    admission: Option<Admission>,
    consistency: String,
    cleanup_authorized: bool,
    snapshot: Snapshot,
}

pub(super) fn decode(bytes: &[u8], record: &Record, nonce: &str) -> Option<Result> {
    if bytes.len() > MAX_OUTPUT {
        return None;
    }
    let value: Receipt = serde_json::from_slice(bytes).ok()?;
    if value.schema_version != 1
        || value.runner_id != record.runner_id
        || value.token != record.admission.as_ref()?.token().ok()?
        || value.observation_id != nonce
        || value.consistency != "pointInTime"
        || value.cleanup_authorized
    {
        return None;
    }
    match &value.snapshot {
        Snapshot::Missing {} if value.admission.is_none() => return None,
        Snapshot::Present {
            entries,
            other_entries,
        } => {
            if value.admission.is_none()
                || entries.len() > 9
                || *other_entries > MAX_ENTRIES.saturating_sub(entries.len())
                || entries
                    .iter()
                    .map(|entry| entry.name)
                    .collect::<HashSet<_>>()
                    .len()
                    != entries.len()
                || entries
                    .iter()
                    .any(|entry| match (&entry.kind, &entry.size_bytes) {
                        (Kind::File, Some(size)) => size
                            .parse::<u64>()
                            .ok()
                            .is_none_or(|number| number.to_string() != *size),
                        (Kind::File, None) => true,
                        (_, size) => size.is_some(),
                    })
            {
                return None;
            }
        }
        Snapshot::Unavailable { reason }
            if value.admission.is_none()
                && !matches!(
                    reason,
                    SnapshotReason::AdmissionUnavailable | SnapshotReason::UnsafeDirectory
                ) =>
        {
            return None
        }
        _ => {}
    }
    Some(Result::Observed {
        admission: value.admission,
        consistency: "pointInTime",
        cleanup_authorized: false,
        snapshot: value.snapshot,
    })
}
