use super::super::{
    contracts::receipt::{Phase, Publication},
    journal::{Record, Stage},
};
use crate::ssh::files::remote_editor::PendingCleanup;

pub(super) fn record(record: &Record) -> PendingCleanup {
    let scope = &record.binding.authority.context.scope;
    let path = record.binding.target_path();
    let action = if matches!(
        record.stage,
        Stage::Reserved | Stage::Ready | Stage::Abandoned
    ) {
        "discard"
    } else if record.disposable() || record.released() {
        "finish"
    } else {
        "query"
    };
    let error = if action == "discard" {
        "editor.nativeUnsent"
    } else if action == "finish" {
        "editor.nativeReleased"
    } else if record.observation.as_ref().is_some_and(|receipt| {
        receipt.publication == Publication::Published
            && matches!(receipt.phase, Phase::Succeeded | Phase::Conflict)
    }) {
        "editor.nativePublished"
    } else {
        "editor.remoteOutcomeUnknown"
    };
    PendingCleanup {
        id: format!("native-{}", record.binding.operation_id),
        path,
        directory: scope.clone(),
        address: record.binding.destination.address.clone(),
        source: "native",
        action: Some(action),
        updated_at: 0, // Legacy journal has no wall-clock field; never invent a timestamp.
        error: Some(error.into()),
        running: false, // A historical live receipt is not proof the worker is still live now.
    }
}
pub(super) fn unavailable(error: &str) -> PendingCleanup {
    PendingCleanup {
        id: "native-store".into(),
        path: String::new(),
        directory: String::new(),
        address: String::new(),
        source: "native",
        action: Some("reload"),
        updated_at: 0,
        error: Some(error.into()),
        running: false,
    }
}
