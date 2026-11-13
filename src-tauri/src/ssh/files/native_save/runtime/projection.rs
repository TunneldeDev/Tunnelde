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
    } else if record
        .observation
        .as_ref()
        .is_some_and(|receipt| receipt.releasable())
    {
        "release"
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

pub(super) fn setup(setup: &super::super::journal::setup::Record) -> PendingCleanup {
    let unsent = setup.stage == super::super::journal::setup::Stage::Reserved;
    PendingCleanup {
        id: format!("native-setup-{}", setup.id),
        path: setup.plan.selection.executable.clone(),
        directory: setup.plan.selection.directory.clone(),
        address: setup.plan.destination.address.clone(),
        source: "native",
        action: Some(if unsent { "discard" } else { "inspect" }),
        updated_at: 0,
        error: Some(
            if unsent {
                "editor.nativeUnsent"
            } else {
                "editor.remoteOutcomeUnknown"
            }
            .into(),
        ),
        running: false,
    }
}

pub(super) fn legacy(
    claim: &super::super::journal::admission::Claim,
    running: bool,
) -> PendingCleanup {
    use super::super::journal::admission::Phase;
    let first = claim.scopes.first();
    PendingCleanup {
        id: format!("native-legacy-{}", claim.id),
        path: first
            .and_then(|scope| scope.paths.first())
            .cloned()
            .unwrap_or_default(),
        directory: String::new(),
        address: first
            .map(|scope| scope.destination.address.clone())
            .unwrap_or_default(),
        source: "native",
        action: Some(if claim.phase == Phase::Terminal {
            "finish"
        } else if claim.phase == Phase::Prepared {
            "discard"
        } else {
            "inspect"
        }),
        updated_at: 0,
        error: Some(
            if claim.phase == Phase::Terminal {
                "sftp.terminalProjectionPending"
            } else if claim.phase == Phase::Prepared {
                "editor.nativeUnsent"
            } else {
                "editor.remoteOutcomeUnknown"
            }
            .into(),
        ),
        running,
    }
}
