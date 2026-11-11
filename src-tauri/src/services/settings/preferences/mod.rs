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
