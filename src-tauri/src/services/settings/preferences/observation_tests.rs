use super::*;
use crate::{db::Database, services::settings::repository};
use serde_json::{json, Value};

fn request(value: Value) -> contracts::Observe {
    serde_json::from_value(value).unwrap()
}

#[test]
fn observation_requests_reject_unknown_fields_null_and_unbounded_tokens() {
    for invalid in [
        Value::Null,
        json!([]),
        json!({"revision":null}),
        json!({"revision":1}),
        json!({"revision":""}),
        json!({"revision":"x".repeat(129)}),
        json!({"revision":"😀".repeat(33)}),
        json!({"revision":"a\nb"}),
        json!({"revision":"r","extra":true}),
    ] {
        assert!(
            serde_json::from_value::<contracts::Observe>(invalid.clone()).is_err(),
            "accepted {invalid}"
        );
    }
    assert!(request(json!({})).revision.is_none());
    assert_eq!(
        request(json!({"revision":"😀".repeat(32)}))
            .revision
            .unwrap()
            .len(),
        128
    );
}

#[test]
fn idle_observation_has_no_values_and_initial_read_excludes_internal_metadata() {
    let mut current = Settings::default();
    current.sanitize();
    current.last_update_check = Some(123);
    current.skipped_version = Some("private-metadata-marker".into());
    let first =
        serde_json::to_value(project(&current, "r".into(), request(json!({}))).unwrap()).unwrap();
    assert_eq!(first["version"], 1);
    assert_eq!(first["changed"], true);
    assert_eq!(first["revision"], first["snapshot"]["revision"]);
    assert_eq!(
        first["snapshot"]["values"],
        projection::values(&current).unwrap()
    );
    assert!(!first.to_string().contains("private-metadata-marker"));
    assert!(first["snapshot"]["values"].get("uiProviders").is_none());
    let idle = serde_json::to_value(
        project(&current, "r".into(), request(json!({"revision":"r"}))).unwrap(),
    )
    .unwrap();
    assert_eq!(idle, json!({"version":1,"revision":"r","changed":false}));
}

#[test]
fn persistent_revision_observes_metadata_aba_and_failed_commits_conservatively() {
    let database = Database::in_memory().unwrap();
    database
        .with(|conn| {
            let mut current = Settings::default();
            current.sanitize();
            let first = repository::save(conn, &current)?;
            current.theme = "dark".into();
            repository::save(conn, &current)?;
            current.theme = "system".into();
            let third = repository::save(conn, &current)?;
            let observed = project(&current, third.clone(), request(json!({"revision":first})))?;
            assert!(observed.changed);
            assert_eq!(observed.snapshot.unwrap().revision, third);
            current.last_update_check = Some(42);
            let metadata = repository::save(conn, &current)?;
            assert!(
                project(
                    &current,
                    metadata.clone(),
                    request(json!({"revision":third}))
                )?
                .changed
            );
            conn.execute_batch(
                "CREATE TRIGGER reject_settings BEFORE UPDATE ON settings
            BEGIN SELECT RAISE(FAIL, 'test failed commit'); END;",
            )?;
            assert!(repository::save(conn, &current).is_err());
            let persisted = crate::db::settings::load(conn)?;
            let revision = repository::revision(conn, &persisted)?;
            assert!(!project(&persisted, revision, request(json!({"revision":metadata})))?.changed);
            Ok(())
        })
        .unwrap();
}
