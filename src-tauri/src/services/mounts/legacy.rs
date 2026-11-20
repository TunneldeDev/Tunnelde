//! Persistent half of one-time mount adoption. Never owns or promotes the
//! original SSH session into a dedicated group connection.
use super::{
    contract::{Entry, Group, Rule, Save},
    repository,
};
use crate::{error::AppResult, mounts::MountInfo, services::operations::Cancellation};
use rusqlite::Connection;

pub(crate) struct Conversion {
    pub(crate) rule: String,
    pub(crate) group: String,
    pub(crate) expected: String,
    pub(crate) name: String,
}
impl Conversion {
    pub(crate) fn save(
        &self,
        conn: &Connection,
        mount: &MountInfo,
        host: &str,
        cancel: &Cancellation,
    ) -> AppResult<Entry<Rule>> {
        crate::db::atomic(conn, |conn| {
            let group =
                repository::get::<Group>(conn, &self.group)?.ok_or_else(repository::changed)?;
            if group.revision != self.expected || group.value.host_id != host {
                return Err(repository::changed());
            }
            cancel.commit()?;
            repository::save(
                conn,
                Save {
                    value: Rule {
                        id: self.rule.clone(),
                        host_id: group.value.host_id,
                        group_id: self.group.clone(),
                        name: self.name.clone(),
                        remote_path: mount.remote_path.clone(),
                        mount_point: mount.mount_point.clone(),
                        read_only: mount.read_only,
                        auto_mount: false,
                    },
                    expected_revision: None,
                },
            )
        })
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::{db::Database, services::mounts::repository};
    pub(crate) fn setup() -> (Database, Conversion, MountInfo, String) {
        let db = Database::in_memory().unwrap();
        let (host, group) = db
            .with(|conn| {
                let input: crate::models::HostInput = serde_json::from_value(
                    serde_json::json!({"name":"Legacy","host":"qa.invalid","username":"qa"}),
                )
                .unwrap();
                let host = crate::db::hosts::create_host(conn, &input.validate().unwrap())?.id;
                let group = crate::db::atomic(conn, |conn| {
                    repository::save(
                        conn,
                        Save {
                            value: Group {
                                id: "group".into(),
                                host_id: host.clone(),
                                name: "Mounts".into(),
                                auto_reconnect: true,
                            },
                            expected_revision: None,
                        },
                    )
                })?;
                Ok((host, group))
            })
            .unwrap();
        let conversion = Conversion {
            rule: "rule".into(),
            group: group.value.id,
            expected: group.revision,
            name: "Legacy files".into(),
        };
        let mount = MountInfo {
            id: "old-runtime".into(),
            owner: "legacy-plugin".into(),
            session_id: "user-terminal-session".into(),
            remote_path: "/source".into(),
            mount_point: if cfg!(windows) {
                "X:\\"
            } else {
                "/tmp/tunnelde-legacy"
            }
            .into(),
            read_only: false,
            cleanup_error: None,
        };
        (db, conversion, mount, host)
    }
    #[test]
    fn conversion_is_create_only_same_host_revision_bound_and_never_auto_mounts() {
        let (db, conversion, mount, host) = setup();
        let (cancel, _pending) = Cancellation::for_test("cancelled");
        let before = db.with(repository::revision).unwrap();
        assert!(db
            .with(|conn| conversion.save(conn, &mount, "other-host", &cancel))
            .is_err());
        let wrong = Conversion {
            expected: "stale".into(),
            rule: conversion.rule.clone(),
            group: conversion.group.clone(),
            name: conversion.name.clone(),
        };
        assert!(db
            .with(|conn| wrong.save(conn, &mount, &host, &cancel))
            .is_err());
        assert_eq!(db.with(repository::revision).unwrap(), before);
        let rule = db
            .with(|conn| conversion.save(conn, &mount, &host, &cancel))
            .unwrap();
        assert_eq!(rule.value.host_id, host);
        assert_eq!(rule.value.remote_path, mount.remote_path);
        assert_eq!(rule.value.mount_point, mount.mount_point);
        assert!(!rule.value.auto_mount);
        assert!(!rule.value.read_only);
        assert!(db
            .with(|conn| conversion.save(conn, &mount, &host, &cancel))
            .is_err());
        assert_eq!(
            db.with(|conn| repository::all::<Rule>(conn, None))
                .unwrap()
                .len(),
            1
        );
    }
    #[test]
    fn cancelled_admission_and_sql_failure_leave_no_saved_rule_or_revision_change() {
        for cancelled in [false, true] {
            let (db, conversion, mount, host) = setup();
            let before = db.with(repository::revision).unwrap();
            let (cancel, pending) = Cancellation::for_test("cancelled");
            if cancelled {
                drop(pending);
            } else {
                db.with(|conn| { conn.execute_batch("CREATE TRIGGER reject_legacy_rule BEFORE INSERT ON mount_rules BEGIN SELECT RAISE(ABORT, 'test failure'); END;")?; Ok(()) }).unwrap();
            }
            assert!(db
                .with(|conn| conversion.save(conn, &mount, &host, &cancel))
                .is_err());
            assert!(db
                .with(|conn| repository::all::<Rule>(conn, None))
                .unwrap()
                .is_empty());
            assert_eq!(db.with(repository::revision).unwrap(), before);
        }
    }
}
