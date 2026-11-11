//! A durable mutation intent is not evidence that its remote operation completed.
use serde::{Deserialize, Serialize};

use super::super::{
    authorize, lifecycle, model::LaunchState, repository, Deployment, HostContext, Record,
};
use crate::error::{AppError, AppResult};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::plugins::runners) enum State {
    Reserved,
    Creating,
    Uploading,
    Ready,
}

impl State {
    pub(in crate::plugins::runners) fn name(self) -> &'static str {
        match self {
            Self::Reserved => "reserved",
            Self::Creating => "creating",
            Self::Uploading => "uploading",
            Self::Ready => "ready",
        }
    }
}

fn reserve_into(records: &mut Vec<Record>, record: Record) -> AppResult<()> {
    if records.len() >= repository::MAX_RECORDS {
        return Err(AppError::validation("plugin.runners.tooManyTasks"));
    }
    if records.iter().any(|other| {
        other.runner_id == "deployment"
            && other.deployment.host_id == record.deployment.host_id
            && other.deployment.directory == record.deployment.directory
    }) {
        return Err(AppError::validation("plugin.runners.deploymentIncomplete"));
    }
    records.push(record);
    Ok(())
}

pub(super) fn reserve(context: &HostContext, deployment: Deployment) -> AppResult<Record> {
    let record = Record {
        runner_id: "deployment".into(),
        deployment,
        stop_pending: false,
        runtime_owner: Some(lifecycle::Owner::current(context.generation)),
        revision: 1,
        launch_state: LaunchState::Confirmed,
        controller_fingerprint: None,
        terminal_status: None,
        deployment_state: Some(State::Reserved),
        configuration_state: None,
        configuration_transport: None,
        admission: None,
    };
    repository::transaction(context, |records| {
        authorize(context, &["ssh.exec", "fs.read", "sftp.write"])?;
        reserve_into(records, record.clone())
    })?;
    Ok(record)
}

fn transition(record: &mut Record, state: State) -> AppResult<()> {
    if !matches!(
        (record.deployment_state, state),
        (Some(State::Reserved), State::Creating)
            | (Some(State::Creating), State::Uploading)
            | (Some(State::Uploading), State::Ready)
    ) {
        return Err(AppError::validation("plugin.runners.recordChanged"));
    }
    record.advance()?;
    record.deployment_state = Some(state);
    Ok(())
}

pub(super) fn advance(context: &HostContext, observed: &Record, state: State) -> AppResult<Record> {
    let mut next = observed.clone();
    transition(&mut next, state)?;
    if !repository::compare_update(context, observed, |record| {
        *record = next.clone();
        Ok(())
    })? {
        return Err(AppError::validation("plugin.runners.recordChanged"));
    }
    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn record() -> Record {
        serde_json::from_value(serde_json::json!({
            "runnerId":"deployment", "stopPending":false, "deploymentState":"reserved",
            "deployment":{"hostId":"host","directory":"/runner","platform":"posix",
                "executable":"python","runner":"helper","entry":"entry"}
        }))
        .unwrap()
    }
    #[test]
    fn only_acknowledged_sequential_transitions_can_make_a_deployment_usable() {
        let mut pending = record();
        assert!(!pending.deployment_ready());
        assert!(transition(&mut pending, State::Ready).is_err());
        transition(&mut pending, State::Creating).unwrap();
        let persisted = serde_json::to_vec(&pending).unwrap();
        pending = serde_json::from_slice(&persisted).unwrap();
        assert!(!pending.deployment_ready());
        assert!(transition(&mut pending, State::Reserved).is_err());
        transition(&mut pending, State::Uploading).unwrap();
        assert!(!pending.deployment_ready());
        transition(&mut pending, State::Ready).unwrap();
        assert!(pending.deployment_ready());
        assert!(transition(&mut pending, State::Creating).is_err());
        pending.deployment_state = None;
        assert!(pending.deployment_ready());
    }
    #[test]
    fn reservations_enforce_capacity_and_preserve_prior_same_destination_intents() {
        let mut records = vec![record()];
        assert!(reserve_into(&mut records, record()).is_err());
        assert_eq!(records.len(), 1);
        let mut another = record();
        another.deployment.directory = "/other".into();
        reserve_into(&mut records, another).unwrap();
        let mut full = vec![record(); repository::MAX_RECORDS];
        assert!(reserve_into(&mut full, record()).is_err());
        assert_eq!(full.len(), repository::MAX_RECORDS);
    }
}
