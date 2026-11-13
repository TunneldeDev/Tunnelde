//! Private recovery authority, deliberately separate from the resettable App DB.
pub(super) mod admission;
mod database;
mod finalization;
mod record;
pub(super) mod setup;
mod sqlite;
#[cfg(test)]
mod tests;

pub(super) use record::Selection;
pub(super) use record::{Binding, Owner, Record, Stage};
pub(super) struct Journal {
    conn: rusqlite::Connection,
    directory: std::path::PathBuf,
    directory_identity: crate::platform::editor_file::Identity,
    file_identity: crate::platform::editor_file::Identity,
    id: String,
    schema_version: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Error {
    Unavailable,
    Unrecognized,
    Changed,
    Capacity,
    Occupied,
    SecretUnavailable,
    SecretChanged,
    NotDispatched,
}
pub(super) type Result<T> = std::result::Result<T, Error>;

/// Non-cloneable, single-use proof of a FULL durable possible-dispatch checkpoint.
/// Only the journal can create one. Recovery never produces another submit permit.
pub(super) struct DispatchPermit {
    binding: Binding,
}
impl DispatchPermit {
    pub fn matches(
        &self,
        authority: &super::contracts::authority::Authority,
        prepared: &super::contracts::operation::Prepared,
    ) -> bool {
        self.binding.matches(authority, prepared)
    }
}
