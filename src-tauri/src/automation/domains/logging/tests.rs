use super::*;
use crate::db::Database;
use serde_json::json;
use std::path::PathBuf;

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let dir =
            std::env::temp_dir().join(format!("tunnelde-local-logs-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&dir).unwrap();
        Self(dir)
    }
    fn path(&self) -> PathBuf {
        self.0.join("2026-11-13.tunnelde.jsonl.log")
    }
    fn page(&self, db: &Database, params: Value) -> Result<Value, Failure> {
        project(&self.0, db, parse(params)?, || Ok(()))
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}
fn line(message: &str, domain: &str) -> String {
    format!(
        "{}\n",
        json!({"timestamp":"2026-11-13T10:00:00Z", "level":"WARN",
        "fields":{"message":message,"domain":domain,"plugin_id":"fixture-plugin","password":"never-return-this-value"}})
    )
}

pub(in super::super) fn samples(db: &Database) -> Vec<Value> {
    let fixture = Fixture::new();
    std::fs::write(fixture.path(), line("actual local projection", "network")).unwrap();
    db.with(|conn| {
        conn.execute(
            "INSERT INTO audit_log (ts,action,target) VALUES (?1,?2,?3)",
            rusqlite::params![1_700_000_000_000_i64, "plugin.started", "fixture-plugin"],
        )?;
        Ok(())
    })
    .unwrap();
    [
        json!({"filter":{"domains":["network"],"levels":["warn"],"plugins":["fixture-plugin"]}}),
        json!({"source":"operations","limit":1}),
    ]
    .into_iter()
    .map(|params| {
        let result = fixture.page(db, params.clone()).unwrap();
        assert_eq!(result["entries"].as_array().unwrap().len(), 1);
        json!({"method":"logs.read","params":params,"result":result})
    })
    .collect()
}

#[test]
fn local_parameters_keep_the_shared_filter_bounds_and_explicit_failures() {
    for params in [
        json!({"path":"/private"}),
        json!({"cursor":null}),
        json!({"limit":201}),
        json!({"filter":{"text":"界".repeat(86)}}),
        json!({"filter":{"levels":["WARN"]}}),
        json!({"filter":{"domains":["network","network"]}}),
    ] {
        assert_eq!(parse(params).err().unwrap().code, "invalid_request");
    }
    assert!(parse(json!({"filter":{"text":"界".repeat(85)}})).is_ok());
    let hidden = map_error(AppError::internal("private path and secret"));
    assert_eq!(hidden.code, "operation_rejected");
    assert!(!hidden.message.contains("private"));
    assert!(!hidden.message.contains("secret"));
}

#[test]
fn adapter_filters_redacts_and_pages_without_duplicate_entries() {
    let fixture = Fixture::new();
    let db = Database::in_memory().unwrap();
    std::fs::write(
        fixture.path(),
        line("first", "network") + &line("skip", "ssh") + &line("second", "network"),
    )
    .unwrap();
    let first = fixture
        .page(&db, json!({"limit":1,"filter":{"domains":["network"]}}))
        .unwrap();
    assert_eq!(first["entries"][0]["message"], "first");
    assert_eq!(first["hasMore"], true);
    assert!(!first.to_string().contains("never-return-this-value"));
    let second = fixture
        .page(
            &db,
            json!({"limit":1,"cursor":first["cursor"],"filter":{"domains":["network"]}}),
        )
        .unwrap();
    assert_eq!(second["entries"][0]["message"], "second");
    assert_eq!(second["hasMore"], false);
    for params in [
        json!({"cursor":first["cursor"]}),
        json!({"cursor":first["cursor"],"source":"operations","filter":{"domains":["network"]}}),
    ] {
        assert_eq!(
            fixture.page(&db, params).unwrap_err().code,
            "invalid_request"
        );
    }
    let foreign = read::read(
        &fixture.0,
        &db,
        "fixture-plugin:fingerprint:1",
        parse(json!({})).unwrap(),
        || Ok(()),
    )
    .unwrap();
    assert_eq!(
        fixture
            .page(&db, json!({"cursor":foreign.cursor}))
            .unwrap_err()
            .code,
        "invalid_request"
    );
    std::fs::write(fixture.path(), line("replacement", "network")).unwrap();
    let reset = fixture
        .page(
            &db,
            json!({"cursor":second["cursor"],"filter":{"domains":["network"]}}),
        )
        .unwrap();
    assert_eq!(reset["reset"], true);
    assert_eq!(reset["entries"][0]["message"], "replacement");
}
