//! Explicit recovery capabilities and bounded host-only projections.
use super::{contracts::Entry, query::token};
use crate::{
    error::AppResult,
    plugins::runners::{identity, model::LaunchState, Record},
    ssh::session::SessionIdentity,
};

pub(super) fn entry(
    record: &Record,
    sessions: &[(String, SessionIdentity)],
    current: Option<&str>,
    grant: bool,
) -> AppResult<Entry> {
    let control_changed = current.is_some_and(|fingerprint| fingerprint != record.controller());
    let bound = identity::select(record, sessions, false);
    let legacy = record.deployment.identity.is_none();
    let candidate = identity::select(record, sessions, true);
    let connection = if bound.is_ok() {
        "connected"
    } else if legacy {
        if candidate
            .as_ref()
            .err()
            .is_some_and(|error| error.to_string() == "plugin.runners.destinationAmbiguous")
        {
            "ambiguous"
        } else {
            "legacy"
        }
    } else if sessions
        .iter()
        .any(|(_, value)| value.host_id == record.deployment.host_id)
    {
        "changed"
    } else {
        "offline"
    };
    let deployment = record.runner_id == "deployment";
    let deployment_state = deployment.then(|| {
        record
            .deployment_state
            .unwrap_or(super::super::deployment::journal::State::Ready)
    });
    Ok(Entry {
        token: token(record)?,
        runner_id: record.runner_id.clone(),
        host_id: record.deployment.host_id.clone(),
        directory: record.deployment.directory.clone(),
        configuration_path: configuration_path(record),
        can_browse: !legacy,
        address: record
            .deployment
            .identity
            .as_ref()
            .map(|value| value.address.clone()),
        server_key: record
            .deployment
            .identity
            .as_ref()
            .map(|value| value.server_key.clone()),
        stop_pending: record.stop_pending,
        launch_uncertain: record.launch_state == LaunchState::Unconfirmed,
        terminal_status: record.terminal_status.map(|value| {
            match value {
                super::super::model::TerminalState::Stopped => "stopped",
                super::super::model::TerminalState::Failed => "failed",
                super::super::model::TerminalState::NotFound => "notFound",
            }
            .into()
        }),
        connection,
        control_changed,
        can_review_destination: legacy && candidate.is_ok(),
        can_handoff: !deployment
            && record.terminal_status.is_none()
            && control_changed
            && grant
            && bound.is_ok()
            && !record.stop_pending,
        can_inspect: !deployment && bound.is_ok(),
        can_stop: !deployment && record.terminal_status.is_none() && !record.stop_pending,
        can_forget: (deployment_state == Some(super::super::deployment::journal::State::Reserved))
            || (!deployment
                && record.terminal_status.is_some()
                && !record.stop_pending
                && !record.configuration_uncertain()),
        deployment_state: deployment_state.map(|state| state.name()),
        configuration_state: record.configuration_state.map(|state| state.name()),
    })
}

fn configuration_path(record: &Record) -> Option<String> {
    (record.configuration_state.is_some()
        && record.runner_id != "deployment"
        && !record.runner_id.is_empty()
        && record.runner_id.len() <= 128
        && record
            .runner_id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"-_".contains(&c)))
    .then(|| {
        super::super::path_join(
            &record.deployment.directory,
            &format!("config-{}.json", record.runner_id),
            &record.deployment.platform,
        )
    })
}
