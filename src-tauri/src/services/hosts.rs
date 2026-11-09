use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::db::{self, Database};
use crate::error::{AppError, AppResult};
use crate::models::{Group, GroupInput, Host, HostInput};
use crate::state::AppState;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub groups: Vec<Group>,
    pub hosts: Vec<Host>,
}

/// External effects are injected so transports cannot bypass domain behavior.
pub(crate) trait Effects {
    fn renamed(&self, id: &str, name: &str);
    fn forget_credential(&self, id: &str);
    fn changed(&self);
}

pub(crate) struct Runtime<'a> {
    app: &'a AppHandle,
    state: &'a AppState,
}

impl Effects for Runtime<'_> {
    fn renamed(&self, id: &str, name: &str) {
        self.state.ssh.rename_host(id, name);
    }

    fn forget_credential(&self, id: &str) {
        let _ = crate::vault::forget(id);
    }

    fn changed(&self) {
        // Preserve the existing invalidation event. Both transports now emit it
        // after commit, including native UI mutations made outside the host list.
        let _ = self.app.emit(
            "plugin://domain-changed",
            serde_json::json!({"domain":"hosts","sessionId":null}),
        );
    }
}

pub(crate) fn service<'a>(app: &'a AppHandle, state: &'a AppState) -> Hosts<'a, Runtime<'a>> {
    Hosts {
        db: &state.db,
        effects: Runtime { app, state },
    }
}

pub(crate) struct Hosts<'a, E: Effects> {
    db: &'a Database,
    effects: E,
}

/// A snapshot is read under one database lock; no transport or UI state leaks.
pub(crate) fn snapshot(db: &Database) -> AppResult<Snapshot> {
    db.with(|conn| {
        Ok(Snapshot {
            groups: db::hosts::list_groups(conn)?,
            hosts: db::hosts::list_hosts(conn)?,
        })
    })
}

impl<E: Effects> Hosts<'_, E> {
    pub fn create(&self, input: HostInput) -> AppResult<Host> {
        let draft = input.validate()?;
        let host = self.db.with(|conn| db::hosts::create_host(conn, &draft))?;
        crate::logs::record(self.db, "host.create", Some(&host.id));
        self.effects.changed();
        Ok(host)
    }

    pub fn update(&self, id: &str, input: HostInput) -> AppResult<Host> {
        let draft = input.validate()?;
        let host = self
            .db
            .with(|conn| db::hosts::update_host(conn, id, &draft))?;
        self.effects.renamed(id, &host.name);
        crate::logs::record(self.db, "host.update", Some(id));
        self.effects.changed();
        Ok(host)
    }

    pub fn delete(&self, id: &str) -> AppResult<()> {
        self.db.with(|conn| {
            let transaction = conn.unchecked_transaction()?;
            db::hosts::delete_host(&transaction, id)?;
            transaction.execute("DELETE FROM settings WHERE key=?1", [format!("route:{id}")])?;
            transaction.commit()?;
            Ok(())
        })?;
        self.effects.forget_credential(id);
        crate::logs::record(self.db, "host.delete", Some(id));
        self.effects.changed();
        Ok(())
    }

    pub fn mark_used(&self, id: &str) -> AppResult<()> {
        self.db.with(|conn| db::hosts::mark_used(conn, id))?;
        self.effects.changed();
        Ok(())
    }

    pub fn reorder(&self, ids: &[String]) -> AppResult<()> {
        if ids.len() > 500 {
            return Err(AppError::validation("host.orderTooLarge"));
        }
        self.db.with(|conn| {
            let transaction = conn.unchecked_transaction()?;
            db::hosts::reorder_hosts(&transaction, ids)?;
            transaction.commit()?;
            Ok(())
        })?;
        self.effects.changed();
        Ok(())
    }

    pub fn create_group(&self, input: GroupInput) -> AppResult<Group> {
        let (name, parent_id) = input.validate()?;
        let group = self
            .db
            .with(|conn| db::hosts::create_group(conn, &name, parent_id.as_deref()))?;
        self.effects.changed();
        Ok(group)
    }

    pub fn update_group(&self, id: &str, input: GroupInput) -> AppResult<Group> {
        let (name, parent_id) = input.validate()?;
        let group = self
            .db
            .with(|conn| db::hosts::update_group(conn, id, &name, parent_id.as_deref()))?;
        self.effects.changed();
        Ok(group)
    }

    pub fn delete_group(&self, id: &str) -> AppResult<()> {
        self.db.with(|conn| db::hosts::delete_group(conn, id))?;
        self.effects.changed();
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
        fn renamed(&self, id: &str, name: &str) {
            self.0.lock().unwrap().push(format!("rename:{id}:{name}"));
        }
        fn forget_credential(&self, id: &str) {
            self.0.lock().unwrap().push(format!("forget:{id}"));
        }
        fn changed(&self) {
            self.0.lock().unwrap().push("changed".into());
        }
    }

    fn input(name: &str) -> HostInput {
        serde_json::from_value(serde_json::json!({"name":name,"host":"192.0.2.1"})).unwrap()
    }

    #[test]
    fn validation_and_failed_mutations_have_no_external_effects() {
        let db = Database::in_memory().unwrap();
        let hosts = Hosts {
            db: &db,
            effects: Recorder::default(),
        };
        assert!(hosts.create(input(" ")).is_err());
        assert!(hosts.update("missing", input("valid")).is_err());
        assert!(hosts.delete("missing").is_err());
        assert!(hosts.reorder(&vec!["missing".into(); 501]).is_err());
        assert!(hosts.effects.0.lock().unwrap().is_empty());
        assert!(snapshot(&db).unwrap().hosts.is_empty());
    }

    #[test]
    fn mutations_share_audit_rename_credentials_and_invalidation() {
        let db = Database::in_memory().unwrap();
        let hosts = Hosts {
            db: &db,
            effects: Recorder::default(),
        };
        let group = hosts
            .create_group(GroupInput {
                name: "Parent".into(),
                parent_id: None,
            })
            .unwrap();
        let mut draft = input("First");
        draft.group_id = Some(group.id.clone());
        let host = hosts.create(draft).unwrap();
        hosts.update(&host.id, input("Second")).unwrap();
        hosts.mark_used(&host.id).unwrap();
        hosts.reorder(std::slice::from_ref(&host.id)).unwrap();
        hosts
            .update_group(
                &group.id,
                GroupInput {
                    name: "Renamed".into(),
                    parent_id: None,
                },
            )
            .unwrap();
        hosts.delete_group(&group.id).unwrap();
        let current = snapshot(&db).unwrap();
        assert_eq!(current.hosts[0].name, "Second");
        assert!(current.hosts[0].last_used_at.is_some());
        assert!(current.groups.is_empty());
        hosts.delete(&host.id).unwrap();
        assert!(snapshot(&db).unwrap().hosts.is_empty());
        let effects = hosts.effects.0.lock().unwrap();
        assert_eq!(
            effects.iter().filter(|effect| *effect == "changed").count(),
            8
        );
        assert!(effects.contains(&format!("rename:{}:Second", host.id)));
        assert!(effects.contains(&format!("forget:{}", host.id)));
        let actions: Vec<String> = db
            .with(|conn| {
                Ok(conn
                    .prepare("SELECT action FROM audit_log ORDER BY id")?
                    .query_map([], |row| row.get(0))?
                    .collect::<Result<_, _>>()?)
            })
            .unwrap();
        assert_eq!(actions, ["host.create", "host.update", "host.delete"]);
    }

    #[test]
    fn route_cleanup_failure_rolls_back_host_and_preserves_credential() {
        let db = Database::in_memory().unwrap();
        let hosts = Hosts {
            db: &db,
            effects: Recorder::default(),
        };
        let host = hosts.create(input("Keep")).unwrap();
        db.with(|conn| {
            conn.execute("INSERT INTO settings (key,value,updated_at) VALUES (?1,'{}',0)", [format!("route:{}", host.id)])?;
            conn.execute_batch("CREATE TRIGGER refuse_route_delete BEFORE DELETE ON settings BEGIN SELECT RAISE(ABORT, 'test failure'); END;")?;
            Ok(())
        }).unwrap();
        hosts.effects.0.lock().unwrap().clear();
        assert!(hosts.delete(&host.id).is_err());
        assert_eq!(snapshot(&db).unwrap().hosts.len(), 1);
        assert!(hosts.effects.0.lock().unwrap().is_empty());
    }

    #[test]
    fn reorder_failure_does_not_leave_a_partially_applied_order() {
        let db = Database::in_memory().unwrap();
        let hosts = Hosts {
            db: &db,
            effects: Recorder::default(),
        };
        let first = hosts.create(input("First")).unwrap();
        let second = hosts.create(input("Second")).unwrap();
        db.with(|conn| {
            conn.execute_batch("CREATE TRIGGER refuse_reorder BEFORE UPDATE OF sort_order ON hosts WHEN OLD.name='First' BEGIN SELECT RAISE(ABORT, 'test failure'); END;")?;
            Ok(())
        }).unwrap();
        hosts.effects.0.lock().unwrap().clear();
        assert!(hosts.reorder(&[second.id, first.id.clone()]).is_err());
        let current = snapshot(&db).unwrap();
        assert_eq!(current.hosts[0].id, first.id);
        assert_eq!(current.hosts[1].sort_order, 1);
        assert!(hosts.effects.0.lock().unwrap().is_empty());
    }
}
