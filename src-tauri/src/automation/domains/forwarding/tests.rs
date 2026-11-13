use super::*;
use crate::services::forwarding::contract::ForwardRule;
use serde_json::json;

fn rule(host: &str, id: &str) -> ForwardRule {
    ForwardRule {
        id: id.into(),
        host_id: host.into(),
        name: "Database".into(),
        mode: "local".into(),
        bind_host: "127.0.0.1".into(),
        bind_port: 15432,
        target_host: "::1".into(),
        target_port: 5432,
    }
}
fn store(db: &Database, rule: &ForwardRule) {
    db.with(|conn| {
        conn.execute(
            "INSERT OR REPLACE INTO settings(key,value,updated_at) VALUES(?1,?2,1)",
            rusqlite::params![format!("forward:{}", rule.id), serde_json::to_string(rule)?],
        )?;
        Ok(())
    })
    .unwrap();
}
fn read(db: &Database, registry: &ForwardRegistry, params: Value) -> Result<Value, Failure> {
    project(db, registry, contract::parse(params)?, || Ok(()))
}
pub(in super::super) fn samples(db: &Database, host: &str) -> Vec<Value> {
    store(db, &rule(host, "local-api-sample"));
    let mut samples = vec![json!({"method":"forwards.list","params":{"limit":1},
        "result":read(db,&ForwardRegistry::default(),json!({"limit":1})).unwrap()})];
    samples.extend(mutations::tests::samples());
    samples
}

#[test]
fn parameters_reject_unknown_fields_wrong_types_and_out_of_budget_tokens() {
    for input in [
        json!(null),
        json!({"limit":0}),
        json!({"limit":129}),
        json!({"limit":1.5}),
        json!({"limit":-1}),
        json!({"after":null}),
        json!({"after":"a\n"}),
        json!({"after":"界".repeat(43)}),
        json!({"after":"\u{85}"}),
        json!({"sessionId":"private"}),
        json!({"path":"/private"}),
    ] {
        assert_eq!(
            contract::parse(input).err().unwrap().code,
            "invalid_request"
        );
    }
    assert_eq!(contract::parse(json!({})).unwrap().limit, 50);
    assert!(contract::parse(json!({"after":"", "limit":128})).is_ok());
    assert!(contract::parse(json!({"after":"界".repeat(42)})).is_ok());
}

#[test]
fn live_keyset_pages_survive_deleted_continuations_and_keep_private_fields_out() {
    let db = Database::in_memory().unwrap();
    let registry = ForwardRegistry::default();
    for id in ["c", "A", "b"] {
        store(&db, &rule("host", id));
    }
    let first = read(&db, &registry, json!({"limit":1})).unwrap();
    assert_eq!(first["entries"][0]["id"], "A");
    assert_eq!(first["nextAfter"], "A");
    let entry = &first["entries"][0];
    assert_eq!(entry.as_object().unwrap().len(), 8);
    assert_eq!(entry["state"], "stopped");
    assert_eq!(entry["direction"], "local");
    assert!(entry.get("sessionId").is_none());
    assert!(entry.get("runtimeId").is_none());
    db.with(|conn| {
        conn.execute("DELETE FROM settings WHERE key='forward:A'", [])?;
        Ok(())
    })
    .unwrap();
    store(&db, &rule("host", "0"));
    store(&db, &rule("host", "d"));
    let next = read(&db, &registry, json!({"after":"A","limit":2})).unwrap();
    assert_eq!(
        next["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| e["id"].as_str().unwrap())
            .collect::<Vec<_>>(),
        ["b", "c"]
    );
    assert_eq!(next["nextAfter"], "c");
    let last = read(&db, &registry, json!({"after":"c"})).unwrap();
    assert_eq!(last["entries"][0]["id"], "d");
    assert!(last["nextAfter"].is_null());
    assert!(
        read(&db, &registry, json!({"after":"zz"})).unwrap()["entries"]
            .as_array()
            .unwrap()
            .is_empty()
    );
}

#[test]
fn byte_budget_returns_a_progressing_continuation_without_dropping_rules() {
    let db = Database::in_memory().unwrap();
    let registry = ForwardRegistry::default();
    for index in 0..128 {
        let mut row = rule("host", &format!("{index:03}"));
        row.name = "\"".repeat(120);
        row.bind_host = "\"".repeat(253);
        row.target_host = "\"".repeat(253);
        store(&db, &row);
    }
    let mut after = String::new();
    let mut seen = Vec::new();
    let mut pages = 0;
    loop {
        let page = read(&db, &registry, json!({"after":after,"limit":128})).unwrap();
        pages += 1;
        assert!(serde_json::to_vec(&page).unwrap().len() <= contract::MAX_PAGE_BYTES);
        for entry in page["entries"].as_array().unwrap() {
            seen.push(entry["id"].as_str().unwrap().to_owned());
        }
        let Some(next) = page["nextAfter"].as_str() else {
            break;
        };
        assert!(next > after.as_str());
        after = next.into();
    }
    assert!(pages > 1);
    assert_eq!(
        seen,
        (0..128).map(|i| format!("{i:03}")).collect::<Vec<_>>()
    );
}

#[test]
fn oversized_or_corrupt_persisted_rows_fail_without_echoing_private_content() {
    for raw in [
        "private-secret".into(),
        "private-secret".repeat(1000),
        serde_json::to_string(&rule("host", "different-id")).unwrap(),
    ] {
        let db = Database::in_memory().unwrap();
        db.with(|conn| {
            conn.execute(
                "INSERT INTO settings(key,value,updated_at) VALUES('forward:a',?1,1)",
                [raw],
            )?;
            Ok(())
        })
        .unwrap();
        let error = read(&db, &ForwardRegistry::default(), json!({})).unwrap_err();
        assert_eq!(error.code, "operation_rejected");
        assert!(!error.message.contains("private-secret"));
    }
}

#[test]
fn cancelled_read_stops_before_entering_persistence() {
    let db = Database::in_memory().unwrap();
    db.with(|conn| {
        conn.execute_batch("DROP TABLE settings")?;
        Ok(())
    })
    .unwrap();
    let error = forwarding::query::page(&db, &ForwardRegistry::default(), "", 1, || {
        Err(crate::error::AppError::validation("cancelled-before-sql"))
    })
    .unwrap_err();
    assert_eq!(error.to_string(), "cancelled-before-sql");
}

#[test]
fn rule_edits_wait_until_persistence_and_runtime_projection_finish() {
    let db = Arc::new(Database::in_memory().unwrap());
    let registry = Arc::new(ForwardRegistry::default());
    store(&db, &rule("host", "one"));
    let (entered, ready) = std::sync::mpsc::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let query_db = db.clone();
    let query_registry = registry.clone();
    let reader = std::thread::spawn(move || {
        let calls = std::sync::atomic::AtomicUsize::new(0);
        let wait = std::sync::Mutex::new(wait);
        forwarding::query::page(&query_db, &query_registry, "", 1, || {
            if calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 1 {
                entered.send(()).unwrap();
                wait.lock().unwrap().recv().unwrap();
            }
            Ok(())
        })
        .unwrap()
    });
    ready
        .recv_timeout(std::time::Duration::from_secs(3))
        .unwrap();
    let edit_registry = registry.clone();
    let (committed, commit) = std::sync::mpsc::channel();
    let writer = std::thread::spawn(move || {
        edit_registry
            .edit("one", || {
                committed.send(()).unwrap();
                Ok(())
            })
            .unwrap()
    });
    assert!(commit
        .recv_timeout(std::time::Duration::from_millis(30))
        .is_err());
    release.send(()).unwrap();
    assert_eq!(reader.join().unwrap().len(), 1);
    commit
        .recv_timeout(std::time::Duration::from_secs(3))
        .unwrap();
    writer.join().unwrap();
}
