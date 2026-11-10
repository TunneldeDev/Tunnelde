use crate::{error::AppResult, settings::Settings, state::AppState};
use tauri::AppHandle;

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
}

pub(crate) async fn writer<'a>(app: &'a AppHandle, state: &'a AppState) -> Writer<'a> {
    // Native commands also run asynchronously: a waiting settings writer must
    // never block the GUI thread needed by another commit's window effects.
    Writer {
        app,
        state,
        _serial: state.settings_commit.lock().await,
    }
}

impl<'a> Writer<'a> {
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
    fn prepare(
        self,
        kind: Kind,
        prepare: impl FnOnce(&Settings) -> AppResult<Settings>,
    ) -> AppResult<Prepared<'a>> {
        let previous = self.state.settings();
        let next = prepare(&previous)?;
        if matches!(kind, Kind::Preferences) {
            crate::update::validate_settings_change(
                &previous,
                &next,
                &self.state.update.snapshot(),
            )?;
        }
        let title_changed = super::effects::stage(self.app, &previous, &next, kind)?;
        Ok(Prepared {
            writer: self,
            previous,
            next,
            kind,
            title_changed,
            committed: false,
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
}
impl Prepared<'_> {
    /// Bounded durable commit only: safe inside the caller's final authorization
    /// lock. Window work, keychain cleanup and events run outside that lock.
    pub(crate) fn persist(&mut self) -> AppResult<()> {
        if self.committed {
            return Ok(());
        }
        self.writer
            .state
            .db
            .with(|conn| crate::db::settings::save(conn, &self.next))?;
        self.writer.state.set_settings(self.next.clone());
        self.committed = true;
        Ok(())
    }
    pub(crate) fn finish(self) -> Settings {
        assert!(
            self.committed,
            "settings must be persisted before publication"
        );
        super::effects::publish(self.writer.app, &self.previous, &self.next, self.kind);
        self.next.clone()
    }
}
impl Drop for Prepared<'_> {
    fn drop(&mut self) {
        if self.title_changed && !self.committed {
            super::effects::rollback_title(self.writer.app, &self.previous);
        }
    }
}
