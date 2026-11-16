//! Durable preferences and companion rows share one commit boundary.
use crate::{db::Database, error::AppResult, settings::Settings};
use rusqlite::Connection;

pub(super) struct Write<'a> {
    pub db: &'a Database,
    pub previous: &'a Settings,
    pub next: &'a Settings,
    pub expected_preferences: Option<&'a str>,
}

impl Write<'_> {
    pub fn save(
        self,
        cancellation: &crate::services::operations::Cancellation,
        before: impl FnOnce(&Connection) -> AppResult<()>,
        extra: impl FnOnce(&Connection) -> AppResult<()>,
    ) -> AppResult<String> {
        self.db
            .with(|conn| self.save_on(conn, cancellation, before, extra))
    }

    pub fn save_on(
        self,
        conn: &Connection,
        cancellation: &crate::services::operations::Cancellation,
        before: impl FnOnce(&Connection) -> AppResult<()>,
        extra: impl FnOnce(&Connection) -> AppResult<()>,
    ) -> AppResult<String> {
        // A cancelled lock waiter must not start a transaction or query.
        cancellation.check()?;
        super::super::repository::save_guarded(
            conn,
            self.next,
            |conn| {
                if let Some(expected) = self.expected_preferences {
                    if super::super::repository::revision(conn, self.previous)? != expected {
                        return Err(crate::error::AppError::validation(
                            "preferences.staleRevision",
                        ));
                    }
                }
                before(conn)?;
                // One winner with caller cancellation, under final CAS and
                // authorization. After admission, publication must finish.
                cancellation.commit()
            },
            extra,
        )
    }
}

#[cfg(test)]
mod tests;
