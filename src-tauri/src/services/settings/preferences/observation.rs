//! Conditional public reads share the writer's serialized snapshot/revision pair.
use super::{contracts, projection};
use crate::{error::AppResult, settings::Settings};

pub(super) fn project(
    current: &Settings,
    revision: String,
    request: contracts::Observe,
) -> AppResult<contracts::Observation> {
    let changed = request.revision.as_ref() != Some(&revision);
    // Avoid serializing either private Settings or public values on idle polls.
    let snapshot = changed
        .then(|| projection::snapshot(current, revision.clone()))
        .transpose()?;
    Ok(contracts::Observation {
        version: 1,
        revision,
        changed,
        snapshot,
    })
}

#[cfg(test)]
#[path = "observation_tests.rs"]
mod tests;
