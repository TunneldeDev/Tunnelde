//! Public preferences domain: schema, projection and mutation have separate owners.
pub(crate) mod contracts;
mod mapping;
mod observation;
mod projection;
mod schema;
mod update;

use super::mutation::{Kind, Prepared, Writer};
use crate::error::{AppError, AppResult};

pub(crate) fn describe() -> contracts::Schema {
    contracts::Schema {
        version: 1,
        stability: "experimental",
        groups: schema::groups().clone(),
    }
}

/// Independent public fields for a saved profile. Provider selections and other
/// private native fields never cross this boundary. Legacy bodies that cannot
/// satisfy the current public schema are rejected rather than silently repaired.
pub(crate) fn profile_values(settings: &crate::settings::Settings) -> AppResult<serde_json::Value> {
    let values = projection::values(settings)?;
    for (id, value) in values.as_object().expect("public preference groups") {
        schema::check(&schema::groups()[id], value, id)?;
    }
    Ok(values)
}

/// Full public profile onto a native baseline. Excluded private fields retain
/// their current values; callers never synthesize an internal Settings patch.
pub(crate) fn apply_profile_values(
    previous: &crate::settings::Settings,
    values: serde_json::Value,
) -> AppResult<crate::settings::Settings> {
    update::full(previous, values)
}

impl Writer<'_> {
    pub(crate) fn observe_preferences(
        &self,
        request: contracts::Observe,
    ) -> AppResult<contracts::Observation> {
        let (current, revision) = self.current()?;
        observation::project(&current, revision, request)
    }

    pub(crate) fn preferences(&self) -> AppResult<contracts::Snapshot> {
        let (current, revision) = self.current()?;
        projection::snapshot(&current, revision)
    }
}

impl<'a> Writer<'a> {
    pub(crate) fn prepare_profile(
        self,
        revision: &str,
        values: serde_json::Value,
    ) -> AppResult<Prepared<'a>> {
        if self.current()?.1 != revision {
            return Err(AppError::validation("preferences.staleRevision"));
        }
        self.prepare(Kind::Preferences, |previous| {
            apply_profile_values(previous, values)
        })
    }

    pub(crate) fn prepare_preferences(self, request: contracts::Update) -> AppResult<Prepared<'a>> {
        let (_, revision) = self.current()?;
        if request.revision != revision {
            return Err(AppError::validation("preferences.staleRevision"));
        }
        self.prepare(Kind::Preferences, |previous| {
            update::apply(previous, request.changes)
        })
    }
}

impl Prepared<'_> {
    pub(crate) fn finish_profile_revision(self) -> String {
        self.finish_with(|_, revision| revision.to_owned())
    }
    pub(crate) fn finish_preferences(self) -> AppResult<contracts::Snapshot> {
        self.finish_with(|next, revision| projection::snapshot(next, revision.to_owned()))
    }
}

fn invalid(path: &str) -> AppError {
    // Paths identify public fields only; arbitrary map keys and values never
    // become diagnostics (they may contain user or proxy identities).
    AppError::validation(format!("preferences.invalidValue:{path}"))
}

#[cfg(test)]
mod tests;
#[cfg(test)]
pub(crate) use tests::local_api_samples;
