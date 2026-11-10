//! Shared command-history behavior. Transports authorize; this service commits and invalidates.
use tauri::{AppHandle, Emitter};

use crate::db::{self, Database};
use crate::error::AppResult;
use crate::state::AppState;

/// Transport projection, independent of database and UI implementation details.
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: i64,
    pub host_id: String,
    pub command: String,
    pub executed_at: i64,
}
impl From<db::history::HistoryEntry> for Entry {
    fn from(value: db::history::HistoryEntry) -> Self {
        Self {
            id: value.id,
            host_id: value.host_id,
            command: value.command,
            executed_at: value.executed_at,
        }
    }
}

pub(crate) trait Effects {
    fn changed(&self, host_id: &str);
}

pub(crate) struct Runtime<'a>(&'a AppHandle);
impl Effects for Runtime<'_> {
    fn changed(&self, host_id: &str) {
        let _ = self.0.emit(
            "plugin://domain-changed",
            serde_json::json!({"domain":"history","hostId":host_id,"sessionId":null}),
        );
    }
}

pub(crate) fn service<'a>(app: &'a AppHandle, state: &'a AppState) -> History<'a, Runtime<'a>> {
    History {
        db: &state.db,
        effects: Runtime(app),
    }
}

pub(crate) struct History<'a, E: Effects> {
    db: &'a Database,
    effects: E,
}

impl<E: Effects> History<'_, E> {
    pub fn list(&self, host_id: &str, limit: Option<i64>) -> AppResult<Vec<Entry>> {
        self.db
            .with(|conn| db::history::list(conn, host_id, limit.unwrap_or(200)))
            .map(|entries| entries.into_iter().map(Entry::from).collect())
    }

    pub fn record(&self, host_id: &str, command: &str) -> AppResult<Option<Entry>> {
        let entry = self.db.with(|conn| {
            db::hosts::find_host(conn, host_id)?;
            db::history::record(conn, host_id, command)
        })?;
        if entry.is_some() {
            self.effects.changed(host_id);
        }
        Ok(entry.map(Entry::from))
    }

    pub fn delete(&self, id: i64) -> AppResult<()> {
        // Resolve ownership and delete under one lock/transaction. A missing row is an idempotent no-op.
        let host_id = self.db.with(|conn| {
            use rusqlite::OptionalExtension;
            let tx = conn.unchecked_transaction()?;
            let host_id: Option<String> = tx
                .query_row(
                    "SELECT host_id FROM command_history WHERE id=?1",
                    [id],
                    |row| row.get(0),
                )
                .optional()?;
            db::history::delete(&tx, id)?;
            tx.commit()?;
            Ok(host_id)
        })?;
        if let Some(host_id) = host_id {
            self.effects.changed(&host_id);
        }
        Ok(())
    }

    pub fn clear(&self, host_id: &str) -> AppResult<()> {
        let changed = self.db.with(|conn| {
            let tx = conn.unchecked_transaction()?;
            let changed: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM command_history WHERE host_id=?1)",
                [host_id],
                |row| row.get(0),
            )?;
            db::history::clear(&tx, host_id)?;
            tx.commit()?;
            Ok(changed)
        })?;
        if changed {
            self.effects.changed(host_id);
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[derive(Default)]
    struct Recorder(Mutex<Vec<String>>);
    impl Effects for Recorder {
        fn changed(&self, host_id: &str) {
            self.0.lock().unwrap().push(host_id.into());
        }
    }
    fn host(db: &Database, name: &str) -> String {
        db.with(|conn| {
            let input: crate::models::HostInput = serde_json::from_value(serde_json::json!({
                "name":name,"host":"example.test","username":"qa","port":22,
                "favorite":false,"tags":[]
            }))
            .unwrap();
            db::hosts::create_host(conn, &input.validate().unwrap())
        })
        .unwrap()
        .id
    }
    #[test]
    fn mutations_invalidate_only_the_owning_host_after_commit() {
        let db = Database::in_memory().unwrap();
        let one = host(&db, "One");
        let two = host(&db, "Two");
        let history = History {
            db: &db,
            effects: Recorder::default(),
        };
        let entry = history.record(&one, "pwd").unwrap().unwrap();
        history.record(&two, "ls").unwrap();
        history.delete(entry.id).unwrap();
        history.clear(&two).unwrap();
        assert_eq!(
            *history.effects.0.lock().unwrap(),
            [one.clone(), two.clone(), one.clone(), two.clone()]
        );
        assert!(history.list(&one, None).unwrap().is_empty());
        assert!(history.list(&two, None).unwrap().is_empty());
        history.delete(entry.id).unwrap();
        history.clear(&two).unwrap();
        assert!(history.record(&one, " ").unwrap().is_none());
        assert!(history.record(&one, &"x".repeat(4001)).unwrap().is_none());
        assert_eq!(history.effects.0.lock().unwrap().len(), 4);
    }
    #[test]
    fn failed_writes_leave_data_and_notifications_unchanged() {
        let db = Database::in_memory().unwrap();
        let one = host(&db, "One");
        let history = History {
            db: &db,
            effects: Recorder::default(),
        };
        let first = history.record(&one, "keep").unwrap().unwrap();
        db.with(|conn| { conn.execute_batch("CREATE TRIGGER refuse_history_delete BEFORE DELETE ON command_history BEGIN SELECT RAISE(ABORT,'test failure'); END;")?; Ok(()) }).unwrap();
        history.effects.0.lock().unwrap().clear();
        assert!(history.record(&one, "keep").is_err());
        assert!(history.record("missing", "pwd").is_err());
        assert!(history.delete(first.id).is_err());
        assert!(history.clear(&one).is_err());
        assert!(history.effects.0.lock().unwrap().is_empty());
        assert_eq!(history.list(&one, None).unwrap()[0].id, first.id);
    }

    #[test]
    fn public_projection_preserves_the_existing_wire_shape() {
        let row = db::history::HistoryEntry {
            id: 42,
            host_id: "host".into(),
            command: "pwd".into(),
            executed_at: 1234,
        };
        assert_eq!(
            serde_json::to_value(Entry::from(row)).unwrap(),
            serde_json::json!({
                "id":42,"hostId":"host","command":"pwd","executedAt":1234
            })
        );
    }
}
