//! Revalidate the exact user-reviewed record inside the metadata transaction.
use super::{contracts::Action, query};
use crate::{
    error::{AppError, AppResult},
    plugins::runners::Record,
};

pub(super) fn index(records: &[Record], token: &str) -> AppResult<usize> {
    if token.len() != 64 || !token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(AppError::validation("plugin.runners.recordChanged"));
    }
    let mut matches = records
        .iter()
        .enumerate()
        .filter(|(_, record)| query::token(record).is_ok_and(|value| value == token));
    let index = matches
        .next()
        .map(|(index, _)| index)
        .ok_or_else(|| AppError::validation("plugin.runners.recordChanged"))?;
    if matches.next().is_some() {
        return Err(AppError::validation("plugin.runners.invalidMetadata"));
    }
    Ok(index)
}

pub(super) fn validate(record: &Record, action: Action) -> AppResult<()> {
    if record.runner_id == "deployment" {
        return Err(AppError::validation("plugin.runners.controlUnavailable"));
    }
    match action {
        Action::Forget if record.stop_pending || record.terminal_status.is_none() => {
            Err(AppError::validation("plugin.runners.exitUnconfirmed"))
        }
        Action::Stop if record.stop_pending || record.terminal_status.is_some() => {
            Err(AppError::validation("plugin.runners.controlUnavailable"))
        }
        _ => Ok(()),
    }
}

pub(super) fn apply(records: &mut Vec<Record>, token: &str, action: Action) -> AppResult<()> {
    let index = index(records, token)?;
    validate(&records[index], action)?;
    match action {
        Action::Forget => {
            records.remove(index);
        }
        Action::Stop => {
            records[index].advance()?;
            records[index].stop_pending = true;
        }
        _ => return Err(AppError::validation("plugin.runners.controlUnavailable")),
    }
    Ok(())
}
