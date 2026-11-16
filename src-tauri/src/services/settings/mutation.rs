use crate::{error::AppResult, settings::Settings, state::AppState};
use tauri::AppHandle;
mod persistence;
mod worker;
pub(crate) use worker::run;

#[derive(Clone, Copy)]
pub(super) enum Kind {
    Preferences,
    Metadata,
}

/// Keep the entire transaction ordered, including notifications. A metadata writer
/// must read after the previous preference commit, rather than save an old snapshot.
pub(crate) struct Writer<'a> {
    app: &'a AppHandle,
    state: &'a AppState,
    _serial: tokio::sync::MutexGuard<'a, ()>,
    cancellation: &'a crate::services::operations::Cancellation,
}

impl<'a> Writer<'a> {
    pub(crate) fn check(&self) -> AppResult<()> {
        self.cancellation.check()
    }
    pub(super) fn current(&self) -> AppResult<(Settings, String)> {
        let current = self.state.settings();
        let revision =
            super::read::revision(&self.state.db, &current, || self.cancellation.check())?;
        Ok((current, revision))
    }
    pub(crate) fn update(self, patch: serde_json::Value) -> AppResult<Settings> {
        self.commit(Kind::Preferences, |previous| {
            super::patch::apply(previous, patch)
        })
    }
    pub(crate) fn prepare_update(self, patch: serde_json::Value) -> AppResult<Prepared<'a>> {
        self.prepare(Kind::Preferences, |previous| {
            super::patch::apply(previous, patch)
        })
    }
    pub(super) fn commit(
        self,
        kind: Kind,
        prepare: impl FnOnce(&Settings) -> AppResult<Settings>,
    ) -> AppResult<Settings> {
        let mut prepared = self.prepare(kind, prepare)?;
        prepared.persist()?;
        Ok(prepared.finish())
    }
    pub(super) fn prepare(
        self,
        kind: Kind,
        prepare: impl FnOnce(&Settings) -> AppResult<Settings>,
    ) -> AppResult<Prepared<'a>> {
        self.cancellation.check()?;
        let previous = self.state.settings();
        let next = prepare(&previous)?;
        if matches!(kind, Kind::Preferences) {
            crate::update::validate_settings_change(
                &previous,
                &next,
                &self.state.update.snapshot(),
            )?;
        }
        self.cancellation.check()?;
        let title_changed = super::effects::stage(self.app, &previous, &next, kind)?;
        Ok(Prepared {
            writer: self,
            previous,
            next,
            kind,
            title_changed,
            committed: false,
            revision: None,
        })
    }
}

pub(crate) struct Prepared<'a> {
    writer: Writer<'a>,
    previous: Settings,
    next: Settings,
    kind: Kind,
    title_changed: bool,
    committed: bool,
    revision: Option<String>,
}
impl Prepared<'_> {
    /// Durable commit only: safe inside the caller's final authorization
    /// lock. Window work, keychain cleanup and events run outside that lock.
    pub(crate) fn persist(&mut self) -> AppResult<()> {
        self.persist_with(|_| Ok(()))
    }
    /// Domain-owned companion rows must commit or roll back with preferences.
    /// The callback does database work only; effects publish after the transaction.
    pub(crate) fn persist_with(
        &mut self,
        extra: impl FnOnce(&rusqlite::Connection) -> AppResult<()>,
    ) -> AppResult<()> {
        self.persist_guarded(None, |_| Ok(()), extra)
    }

    /// Additional domain CAS and cancellation fences run inside the same
    /// transaction before preferences or companion rows are written.
    pub(crate) fn persist_guarded(
        &mut self,
        expected_preferences: Option<&str>,
        before: impl FnOnce(&rusqlite::Connection) -> AppResult<()>,
        extra: impl FnOnce(&rusqlite::Connection) -> AppResult<()>,
    ) -> AppResult<()> {
        if self.committed {
            return Ok(());
        }
        let revision = persistence::Write {
            db: &self.writer.state.db,
            previous: &self.previous,
            next: &self.next,
            expected_preferences,
        }
        .save(self.writer.cancellation, before, extra)?;
        self.writer.state.set_settings(self.next.clone());
        self.writer
            .state
            .update
            .settings_committed(&self.previous, &self.next);
        self.revision = Some(revision);
        self.committed = true;
        Ok(())
    }
    pub(crate) fn finish(self) -> Settings {
        self.finish_with(|next, _| next.clone())
    }
    pub(super) fn finish_with<T>(self, project: impl FnOnce(&Settings, &str) -> T) -> T {
        assert!(
            self.committed,
            "settings must be persisted before publication"
        );
        super::effects::publish(self.writer.app, &self.previous, &self.next, self.kind);
        let result = project(
            &self.next,
            self.revision.as_deref().expect("committed revision"),
        );
        let app = self.writer.app.clone();
        drop(self); // OS retirement is scheduled only after the ordered writer ends.
        crate::services::credentials::schedule_cleanup(&app);
        result
    }
}
impl Drop for Prepared<'_> {
    fn drop(&mut self) {
        if self.title_changed && !self.committed {
            super::effects::rollback_title(self.writer.app, &self.previous);
        }
    }
}
