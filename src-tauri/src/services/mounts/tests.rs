use super::{
    configuration,
    contract::{Entry, Group, Rule, Save},
    repository,
    runtime::Coordinator,
};
use crate::db::{self, Database};
use serde_json::{json, Value};

fn host(db: &Database) -> String {
    db.with(|conn| {
        let input: crate::models::HostInput = serde_json::from_value(
            json!({"name":"Mounts test","host":"example.test","username":"qa"}),
        )
        .unwrap();
        Ok(crate::db::hosts::create_host(conn, &input.validate().unwrap())?.id)
    })
    .unwrap()
}
fn group(host: &str, id: &str) -> Group {
    Group {
        id: id.into(),
        host_id: host.into(),
        name: "Shared".into(),
        auto_reconnect: true,
    }
}
fn rule(host: &str, group: &str, id: &str) -> Rule {
    Rule {
        id: id.into(),
        host_id: host.into(),
        group_id: group.into(),
        name: "Source".into(),
        remote_path: "/source".into(),
        mount_point: if cfg!(windows) {
            "X:\\"
        } else {
            "/tmp/tunnelde-mount-tests"
        }
        .into(),
        read_only: true,
        auto_mount: true,
    }
}
fn save<T: repository::Record>(
    db: &Database,
    value: T,
    revision: Option<String>,
) -> crate::error::AppResult<Entry<T>> {
    db.with(|conn| {
        db::atomic(conn, |conn| {
            repository::save(
                conn,
                Save {
                    value,
                    expected_revision: revision,
                },
            )
        })
    })
}
fn call(
    db: &Database,
    runtime: &Coordinator,
    method: &str,
    params: Value,
) -> crate::error::AppResult<Value> {
    db.with(|conn| {
        db::atomic(conn, |conn| {
            configuration::call(runtime, conn, method, params)
        })
    })
}
#[test]
fn create_only_and_exact_revision_prevent_lost_updates_and_resurrection() {
    let db = Database::in_memory().unwrap();
    let host = host(&db);
    let original = save(&db, group(&host, "one"), None).unwrap();
    assert!(save(&db, original.value.clone(), None).is_err());
    let mut edited = original.value.clone();
    edited.name = "Edited".into();
    let current = save(&db, edited, Some(original.revision.clone())).unwrap();
    assert_ne!(current.revision, original.revision);
    assert!(save(&db, original.value.clone(), Some(original.revision)).is_err());
    db.with(|conn| repository::remove::<Group>(conn, "one", &current.revision))
        .unwrap();
    assert!(save(&db, original.value, Some(current.revision)).is_err());
}
#[test]
fn groups_cannot_cross_hosts_and_host_cascade_invalidates_paging() {
    let db = Database::in_memory().unwrap();
    let first = host(&db);
    let second = host(&db);
    save(&db, group(&first, "a"), None).unwrap();
    assert!(save(&db, rule(&second, "a", "bad"), None).is_err());
    save(&db, rule(&first, "a", "r"), None).unwrap();
    let revision = db.with(repository::revision).unwrap();
    db.with(|conn| {
        conn.execute("DELETE FROM hosts WHERE id=?1", [first])?;
        Ok(())
    })
    .unwrap();
    assert_ne!(revision, db.with(repository::revision).unwrap());
    db.with(|conn| {
        assert!(repository::all::<Rule>(conn, None)?.is_empty());
        assert!(repository::all::<Group>(conn, None)?.is_empty());
        Ok(())
    })
    .unwrap();
}
#[test]
fn paging_is_bounded_and_continuations_reject_changed_collections() {
    let db = Database::in_memory().unwrap();
    let host = host(&db);
    for id in ["a", "b", "c"] {
        save(&db, group(&host, id), None).unwrap();
    }
    db.with(|conn| {
        let page = repository::page::<Group>(conn, Some(&host), None, None, 2)?;
        assert_eq!(page.items.len(), 2);
        assert_eq!(page.next_cursor.as_deref(), Some("b"));
        assert!(repository::page::<Group>(conn, Some(&host), Some("b"), None, 2).is_err());
        assert!(repository::page::<Group>(conn, None, None, None, 33).is_err());
        let tail =
            repository::page::<Group>(conn, Some(&host), Some("b"), Some(&page.revision), 2)?;
        assert_eq!(tail.items[0].value.id, "c");
        assert!(tail.next_cursor.is_none());
        repository::save(
            conn,
            Save {
                value: group(&host, "d"),
                expected_revision: None,
            },
        )?;
        assert!(
            repository::page::<Group>(conn, Some(&host), Some("b"), Some(&page.revision), 2)
                .is_err()
        );
        Ok(())
    })
    .unwrap();
}
#[test]
fn host_copy_allocates_new_ids_and_disables_auto_mount() {
    let db = Database::in_memory().unwrap();
    let source = host(&db);
    let target = host(&db);
    save(&db, group(&source, "g"), None).unwrap();
    save(&db, rule(&source, "g", "r"), None).unwrap();
    let revision = db.with(repository::revision).unwrap();
    let result = call(
        &db,
        &Coordinator::default(),
        "rules.copyHost",
        json!({"sourceHostId":source,"targetHostId":target,"expectedRevision":revision}),
    )
    .unwrap();
    let copied: Vec<Entry<Rule>> = serde_json::from_value(result["rules"].clone()).unwrap();
    assert_eq!(copied.len(), 1);
    assert_ne!(copied[0].value.id, "r");
    assert_ne!(copied[0].value.group_id, "g");
    assert_eq!(copied[0].value.host_id, target);
    assert!(!copied[0].value.auto_mount);
    assert!(call(
        &db,
        &Coordinator::default(),
        "rules.copyHost",
        json!({"sourceHostId":source,"targetHostId":target,"expectedRevision":revision})
    )
    .is_err());
}
#[test]
fn import_requires_exact_preview_and_rolls_back_every_item_on_failure() {
    let db = Database::in_memory().unwrap();
    let host = host(&db);
    let runtime = Coordinator::default();
    let document = json!({"version":1,"hostId":host,"groups":[group(&host,"g")],"rules":[rule(&host,"g","r")]});
    let preview = call(
        &db,
        &runtime,
        "rules.importPreview",
        json!({"document":document}),
    )
    .unwrap();
    assert!(call(
        &db,
        &runtime,
        "rules.importApply",
        json!({"document":document,"expectedRevision":preview["revision"],"digest":"wrong"})
    )
    .is_err());
    db.with(|conn| { conn.execute_batch("CREATE TRIGGER fail_mount_rule BEFORE INSERT ON mount_rules BEGIN SELECT RAISE(ABORT,'test injected failure'); END;")?; Ok(()) }).unwrap();
    let apply = json!({"document":document,"expectedRevision":preview["revision"],"digest":preview["digest"]});
    assert!(call(&db, &runtime, "rules.importApply", apply.clone()).is_err());
    db.with(|conn| {
        assert!(repository::get::<Group>(conn, "g")?.is_none());
        assert_eq!(repository::revision(conn)?, preview["revision"]);
        conn.execute_batch("DROP TRIGGER fail_mount_rule;")?;
        Ok(())
    })
    .unwrap();
    call(&db, &runtime, "rules.importApply", apply.clone()).unwrap();
    assert!(call(&db, &runtime, "rules.importApply", apply).is_err());
    let preview = call(
        &db,
        &runtime,
        "rules.importPreview",
        json!({"document":document,"mode":"replace"}),
    )
    .unwrap();
    assert_eq!(preview["conflicts"].as_array().unwrap().len(), 2);
    let mut altered = document.clone();
    altered["rules"][0]["readOnly"] = false.into();
    assert!(call(&db,&runtime,"rules.importApply",json!({"document":altered,"mode":"replace","digest":preview["digest"],"expectedRevision":preview["revision"]})).is_err());
    call(&db,&runtime,"rules.importApply",json!({"document":document,"mode":"skip","digest":preview["digest"],"expectedRevision":preview["revision"]})).unwrap();
}
#[test]
fn group_gates_serialize_configuration_and_bad_paths_do_not_persist() {
    let db = Database::in_memory().unwrap();
    let host = host(&db);
    let runtime = Coordinator::default();
    save(&db, group(&host, "g"), None).unwrap();
    let gate = runtime.gate("g").unwrap();
    assert!(call(
        &db,
        &runtime,
        "rules.save",
        json!({"rule":rule(&host,"g","r")})
    )
    .is_err());
    drop(gate);
    let mut invalid = rule(&host, "g", "r");
    invalid.remote_path = "/source/../etc".into();
    assert!(call(&db, &runtime, "rules.save", json!({"rule":invalid})).is_err());
    call(
        &db,
        &runtime,
        "rules.save",
        json!({"rule":rule(&host,"g","r")}),
    )
    .unwrap();
    let snapshot = call(&db, &runtime, "rules.snapshot", json!({"hostId":host})).unwrap();
    assert_eq!(snapshot["runtimeRevision"], runtime.revision());
}
