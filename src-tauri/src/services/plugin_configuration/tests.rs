use super::{
    contracts::{
        document::{BackupRequest, Expected, Status, Update},
        schema::Declaration,
    },
    repository::Repository,
    service,
};
use serde_json::{json, Value};

fn schema() -> Declaration {
    serde_json::from_value(json!({"version":1,"groups":[{"id":"general","title":"General"}],"fields":[
    {"id":"enabled","group":"general","title":"Enabled","schema":{"type":"boolean"},"default":false},
    {"id":"name","group":"general","title":"Name","schema":{"type":"string","maxLength":16},"default":"test"}
]})).unwrap()
}
fn put(
    repo: &Repository,
    id: &str,
    schema: &Declaration,
    revision: &str,
    values: Value,
) -> crate::error::AppResult<super::contracts::document::Snapshot> {
    service::update(
        repo,
        id,
        schema,
        Update {
            expected_revision: revision.into(),
            schema_digest: schema.digest().unwrap(),
            values: serde_json::from_value(values).unwrap(),
        },
    )
}
fn upgrade(old: &Declaration) -> Declaration {
    let mut value = serde_json::to_value(old).unwrap();
    value["version"] = 2.into();
    value["fields"][1]["id"] = "label".into();
    let mut next: Declaration = serde_json::from_value(value).unwrap();
    next.migrations = serde_json::from_value(json!([{"fromVersion":1,"fromDigest":old.digest().unwrap(),"toVersion":2,"toDigest":next.digest().unwrap(),"operations":[{"op":"rename","from":"name","to":"label"}]}])).unwrap();
    next
}
fn expected(snapshot: &super::contracts::document::Snapshot) -> Expected {
    Expected {
        expected_revision: snapshot.revision.clone(),
        schema_digest: snapshot.schema_digest.clone(),
    }
}

#[test]
fn reads_are_inert_and_values_are_isolated_cas_protected_with_no_aba() {
    let dir = TestDirectory::new();
    let root = dir.path().join("absent");
    let repo = Repository::at(&root);
    let schema = schema();
    let first = service::read(&repo, "one", &schema).unwrap();
    assert_eq!(first.revision, "initial");
    assert!(!root.exists());
    let saved = put(
        &repo,
        "one",
        &schema,
        "initial",
        json!({"enabled":true,"name":"😀"}),
    )
    .unwrap();
    assert_eq!(
        service::read(&repo, "two", &schema).unwrap().revision,
        "initial"
    );
    assert!(put(
        &repo,
        "one",
        &schema,
        "initial",
        json!({"enabled":false,"name":"test"})
    )
    .unwrap_err()
    .to_string()
    .contains("conflict"));
    let reverted = put(
        &repo,
        "one",
        &schema,
        &saved.revision,
        json!({"enabled":false,"name":"test"}),
    )
    .unwrap();
    assert_ne!(saved.revision, reverted.revision);
    assert!(put(
        &repo,
        "one",
        &schema,
        &saved.revision,
        json!({"enabled":false,"name":"test"})
    )
    .is_err());
    assert!(!root.join("configuration.sqlite3-wal").exists());
}

#[test]
fn schemas_fail_closed_and_defaults_obey_nested_constraints() {
    let original = serde_json::to_value(schema()).unwrap();
    let mut cases = vec![];
    for (path, value) in [
        ("unknown", json!(true)),
        ("version", json!(0)),
        ("groups", json!([])),
    ] {
        let mut bad = original.clone();
        bad[path] = value;
        cases.push(bad);
    }
    for invalid in [
        json!({"type":"boolean","unknown":true}),
        json!({"type":"string","maxLength":-1}),
        json!({"type":"number","minimum":2,"maximum":1}),
        json!({"type":"string","maxLength":5,"enum":["x","x"]}),
        json!({"type":"object","properties":{},"required":["missing"],"additionalProperties":false}),
        json!({"type":"object","properties":{"__proto__":{"type":"boolean"}},"required":[],"additionalProperties":false}),
        json!({"type":"object","properties":{},"required":[],"additionalProperties":true}),
    ] {
        let mut bad = original.clone();
        bad["fields"][0]["schema"] = invalid;
        cases.push(bad);
    }
    let mut bad = original.clone();
    bad["fields"][0]["default"] = "false".into();
    cases.push(bad);
    let mut bad = original.clone();
    bad["fields"][1]["id"] = "enabled".into();
    cases.push(bad);
    let mut bad = original.clone();
    bad["fields"][1]["group"] = "missing".into();
    cases.push(bad);
    for bad in cases {
        assert!(
            serde_json::from_value::<Declaration>(bad.clone())
                .map_or(true, |s| s.validate().is_err()),
            "{bad}"
        );
    }
    let mut nested = original;
    nested["fields"][0]["schema"] = json!({"type":"object","properties":{"paths":{"type":"array","maxItems":2,"items":{"type":"string","maxLength":1}}},"required":["paths"],"additionalProperties":false});
    nested["fields"][0]["default"] = json!({"paths":["😀"]});
    let good: Declaration = serde_json::from_value(nested.clone()).unwrap();
    good.validate().unwrap();
    nested["fields"][0]["default"]["paths"][0] = "😀😀".into();
    assert!(serde_json::from_value::<Declaration>(nested)
        .unwrap()
        .validate()
        .is_err());
}

#[test]
fn metadata_edits_do_not_change_digest_but_data_edits_do() {
    let old = schema();
    let mut next = old.clone();
    next.groups[0].title = "中文".into();
    next.fields[0].title = "启用".into();
    next.fields.reverse();
    assert_eq!(old.digest().unwrap(), next.digest().unwrap());
    next.fields[0].default = "changed".into();
    assert_ne!(old.digest().unwrap(), next.digest().unwrap());
}

#[test]
fn migration_is_explicit_atomic_and_original_data_remains_recoverable() {
    let dir = TestDirectory::new();
    let repo = Repository::at(dir.path());
    let old = schema();
    let new = upgrade(&old);
    let saved = put(
        &repo,
        "one",
        &old,
        "initial",
        json!({"enabled":true,"name":"original"}),
    )
    .unwrap();
    let pending = service::read(&repo, "one", &new).unwrap();
    assert_eq!(pending.status, Status::MigrationRequired);
    assert_eq!(pending.values["name"], "original");
    assert!(put(
        &repo,
        "one",
        &new,
        &saved.revision,
        json!({"enabled":true,"label":"lost"})
    )
    .is_err());
    assert!(service::list_backups(&repo, "one").unwrap().is_empty());
    let migrated = service::migrate(&repo, "one", &new, expected(&pending)).unwrap();
    assert_eq!(migrated.status, Status::Ready);
    assert_eq!(migrated.values["label"], "original");
    let backups = service::list_backups(&repo, "one").unwrap();
    assert_eq!(backups.len(), 1);
    assert_eq!(backups[0].document.values["name"], "original");
    assert!(service::list_backups(&repo, "two").unwrap().is_empty());
    let restored = service::restore(
        &repo,
        "one",
        &new,
        BackupRequest {
            expected_revision: migrated.revision.clone(),
            schema_digest: new.digest().unwrap(),
            backup_id: backups[0].id.clone(),
        },
    )
    .unwrap();
    assert_eq!(restored.status, Status::MigrationRequired);
    assert_ne!(restored.revision, saved.revision);
    assert_eq!(service::list_backups(&repo, "one").unwrap().len(), 2);
    assert!(service::migrate(&repo, "one", &new, expected(&pending))
        .unwrap_err()
        .to_string()
        .contains("conflict"));
}

#[test]
fn downgrade_same_version_drift_and_missing_chain_never_replace_saved_values() {
    let dir = TestDirectory::new();
    let repo = Repository::at(dir.path());
    let old = schema();
    let saved = put(
        &repo,
        "one",
        &old,
        "initial",
        json!({"enabled":true,"name":"keep"}),
    )
    .unwrap();
    let mut drift = old.clone();
    drift.fields[1].default = "changed".into();
    let mut no_chain = upgrade(&old);
    no_chain.migrations.clear();
    for changed in [drift, no_chain] {
        let read = service::read(&repo, "one", &changed).unwrap();
        assert_eq!(read.status, Status::Incompatible);
        assert!(service::migrate(&repo, "one", &changed, expected(&read)).is_err());
        assert!(put(
            &repo,
            "one",
            &changed,
            &saved.revision,
            serde_json::to_value(changed.defaults()).unwrap()
        )
        .is_err());
        assert_eq!(
            service::read(&repo, "one", &old).unwrap().values["name"],
            "keep"
        );
    }
    let new = upgrade(&old);
    let pending = service::read(&repo, "one", &new).unwrap();
    service::migrate(&repo, "one", &new, expected(&pending)).unwrap();
    assert_eq!(
        service::read(&repo, "one", &old).unwrap().status,
        Status::Incompatible
    );
}

#[test]
fn failed_migration_and_failed_database_commit_roll_back_backup_and_document() {
    let dir = TestDirectory::new();
    let repo = Repository::at(dir.path());
    let old = schema();
    let mut next = upgrade(&old);
    let saved = put(
        &repo,
        "one",
        &old,
        "initial",
        json!({"enabled":true,"name":"keep"}),
    )
    .unwrap();
    next.migrations[0]
        .operations
        .push(super::contracts::migration::Operation::Remove {
            key: "missing".into(),
        });
    let read = service::read(&repo, "one", &next).unwrap();
    assert_eq!(read.status, Status::Incompatible);
    assert!(service::migrate(&repo, "one", &next, expected(&read)).is_err());
    let conn = rusqlite::Connection::open(dir.path().join("configuration.sqlite3")).unwrap();
    conn.execute_batch("CREATE TRIGGER fail_update BEFORE UPDATE ON configuration_documents BEGIN SELECT RAISE(ABORT, 'injected failure'); END;").unwrap();
    drop(conn);
    let next = upgrade(&old);
    let read = service::read(&repo, "one", &next).unwrap();
    assert!(service::migrate(&repo, "one", &next, expected(&read)).is_err());
    assert_eq!(
        service::read(&repo, "one", &old).unwrap().revision,
        saved.revision
    );
    assert!(service::list_backups(&repo, "one").unwrap().is_empty());
}

#[test]
fn concurrent_writers_have_exactly_one_winner() {
    let dir = TestDirectory::new();
    let schema = schema();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
    let workers: Vec<_> = (0..2)
        .map(|_| {
            let root = dir.path().to_path_buf();
            let schema = schema.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                put(
                    &Repository::at(&root),
                    "one",
                    &schema,
                    "initial",
                    json!({"enabled":true,"name":"first"}),
                )
                .is_ok()
            })
        })
        .collect();
    assert_eq!(
        workers
            .into_iter()
            .filter(|w| w.thread().id() != std::thread::current().id())
            .map(|w| usize::from(w.join().unwrap()))
            .sum::<usize>(),
        1
    );
}

#[test]
fn backup_quota_requires_explicit_deletion_and_preserves_every_original() {
    let dir = TestDirectory::new();
    let repo = Repository::at(dir.path());
    let old = schema();
    let new = upgrade(&old);
    put(
        &repo,
        "one",
        &old,
        "initial",
        json!({"enabled":true,"name":"keep"}),
    )
    .unwrap();
    let pending = service::read(&repo, "one", &new).unwrap();
    let mut current = service::migrate(&repo, "one", &new, expected(&pending)).unwrap();
    let id = service::list_backups(&repo, "one").unwrap()[0].id.clone();
    for _ in 1..8 {
        current = service::restore(
            &repo,
            "one",
            &new,
            BackupRequest {
                expected_revision: current.revision.clone(),
                schema_digest: new.digest().unwrap(),
                backup_id: id.clone(),
            },
        )
        .unwrap();
    }
    assert!(service::restore(
        &repo,
        "one",
        &new,
        BackupRequest {
            expected_revision: current.revision.clone(),
            schema_digest: new.digest().unwrap(),
            backup_id: id.clone()
        }
    )
    .unwrap_err()
    .to_string()
    .contains("backupLimit"));
    assert_eq!(service::list_backups(&repo, "one").unwrap().len(), 8);
    service::delete_backup(
        &repo,
        "one",
        &new,
        BackupRequest {
            expected_revision: current.revision.clone(),
            schema_digest: new.digest().unwrap(),
            backup_id: id,
        },
    )
    .unwrap();
    assert_eq!(service::list_backups(&repo, "one").unwrap().len(), 7);
}

struct TestDirectory(std::path::PathBuf);
impl TestDirectory {
    fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("tunnelde-configuration-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).unwrap();
        Self(path)
    }
    fn path(&self) -> &std::path::Path {
        &self.0
    }
}
impl Drop for TestDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn first_failed_write_does_not_poison_reading_and_unknown_database_versions_are_preserved() {
    let dir = TestDirectory::new();
    let repo = Repository::at(dir.path());
    let schema = schema();
    assert!(put(
        &repo,
        "one",
        &schema,
        "stale",
        serde_json::to_value(schema.defaults()).unwrap()
    )
    .is_err());
    assert_eq!(
        service::read(&repo, "one", &schema).unwrap().revision,
        "initial"
    );
    put(
        &repo,
        "one",
        &schema,
        "initial",
        serde_json::to_value(schema.defaults()).unwrap(),
    )
    .unwrap();
    let conn = rusqlite::Connection::open(dir.path().join("configuration.sqlite3")).unwrap();
    conn.pragma_update(None, "user_version", 2).unwrap();
    drop(conn);
    assert!(service::read(&repo, "one", &schema)
        .unwrap_err()
        .to_string()
        .contains("storageVersion"));
    assert!(put(
        &repo,
        "one",
        &schema,
        "initial",
        serde_json::to_value(schema.defaults()).unwrap()
    )
    .unwrap_err()
    .to_string()
    .contains("storageVersion"));
    let conn = rusqlite::Connection::open(dir.path().join("configuration.sqlite3")).unwrap();
    assert_eq!(
        conn.pragma_query_value(None, "user_version", |row| row.get::<_, u32>(0))
            .unwrap(),
        2
    );
    assert_eq!(
        conn.query_row("SELECT COUNT(*) FROM configuration_documents", [], |row| {
            row.get::<_, u32>(0)
        })
        .unwrap(),
        1
    );
}
#[test]
fn multi_step_migration_defaults_never_overwrite_values_and_failure_retains_original() {
    let dir = TestDirectory::new();
    let repo = Repository::at(dir.path());
    let old = schema();
    let intermediate = upgrade(&old);
    let mut value = serde_json::to_value(&intermediate).unwrap();
    value["version"] = 3.into();
    value["fields"][1]["id"] = "caption".into();
    let mut current: Declaration = serde_json::from_value(value).unwrap();
    current.migrations.push(serde_json::from_value(json!({"fromVersion":2,"fromDigest":intermediate.digest().unwrap(),"toVersion":3,"toDigest":current.digest().unwrap(),"operations":[{"op":"setDefault","key":"label","value":"wrong"},{"op":"rename","from":"label","to":"caption"}]})).unwrap());
    put(
        &repo,
        "one",
        &old,
        "initial",
        json!({"enabled":false,"name":"keep"}),
    )
    .unwrap();
    let read = service::read(&repo, "one", &current).unwrap();
    let migrated = service::migrate(&repo, "one", &current, expected(&read)).unwrap();
    assert_eq!(migrated.values["caption"], "keep");
    assert_eq!(migrated.stored_version, Some(3));
    assert_eq!(service::list_backups(&repo, "one").unwrap().len(), 1);
}
