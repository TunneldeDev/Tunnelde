//! Persist config intent before dispatch; a lost acknowledgement remains uncertain.
use serde::{Deserialize, Serialize};

use crate::{
    error::{AppError, AppResult},
    plugins::runners::{authorize, repository, HostContext, Record},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(in crate::plugins::runners) enum State {
    Reserved,
    Creating,
    Writing,
    Ready,
}

impl State {
    pub(in crate::plugins::runners) fn name(self) -> &'static str {
        match self {
            Self::Reserved => "reserved",
            Self::Creating => "creating",
            Self::Writing => "writing",
            Self::Ready => "ready",
        }
    }

    pub(in crate::plugins::runners) fn uncertain(self) -> bool {
        matches!(self, Self::Creating | Self::Writing)
    }
}

fn transition(record: &mut Record, state: State) -> AppResult<()> {
    if !matches!(
        (record.configuration_state, state),
        (Some(State::Reserved), State::Creating)
            | (Some(State::Creating), State::Writing)
            | (Some(State::Writing), State::Ready)
    ) {
        return Err(AppError::validation("plugin.runners.recordChanged"));
    }
    record.advance()?;
    record.configuration_state = Some(state);
    Ok(())
}

pub(super) fn current(context: &HostContext, observed: &Record) -> AppResult<()> {
    // A stop in the same runtime advances the record even if permission is intact.
    repository::transaction(context, |records| {
        authorize(context, &["ssh.exec"])?;
        if !records.iter().any(|record| record.same_revision(observed)) {
            return Err(AppError::validation("plugin.runners.recordChanged"));
        }
        Ok(())
    })
}

pub(super) fn advance(context: &HostContext, observed: &Record, state: State) -> AppResult<Record> {
    let mut next = observed.clone();
    transition(&mut next, state)?;
    if !repository::compare_update(context, observed, |record| {
        authorize(context, &["ssh.exec"])?;
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

    #[test]
    fn only_acknowledged_configuration_phases_can_be_ready() {
        let mut record: Record = serde_json::from_value(serde_json::json!({
            "runnerId":"task", "stopPending":true, "configurationState":"reserved",
            "deployment":{"hostId":"host","directory":"/runner","platform":"posix",
                "executable":"python","runner":"helper","entry":"entry"}
        }))
        .unwrap();
        assert!(transition(&mut record, State::Ready).is_err());
        transition(&mut record, State::Creating).unwrap();
        assert!(record.configuration_uncertain());
        record = serde_json::from_slice(&serde_json::to_vec(&record).unwrap()).unwrap();
        transition(&mut record, State::Writing).unwrap();
        assert!(record.configuration_uncertain());
        assert!(transition(&mut record, State::Reserved).is_err());
        transition(&mut record, State::Ready).unwrap();
        assert!(!record.configuration_uncertain());
        assert!(record.stop_pending);
        assert!(transition(&mut record, State::Creating).is_err());
    }
}
