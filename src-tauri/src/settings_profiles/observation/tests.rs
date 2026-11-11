use super::*;
use crate::db::Database;
use serde_json::{json, Value};

fn observe_value(conn: &Connection, revision: Option<&str>) -> AppResult<Value> {
    Ok(serde_json::to_value(observe(
        conn,
        contracts::Observe {
            revision: revision.map(str::to_owned),
        },
    )?)?)
}
fn put_raw(conn: &Connection, value: &str) -> AppResult<()> {
    conn.execute(
        "INSERT OR REPLACE INTO settings(key,value,updated_at) VALUES (?1,?2,0)",
        rusqlite::params![super::super::KEY, value],
    )?;
    Ok(())
}

#[test]
fn strict_requests_reject_unknown_null_and_unbounded_revisions() {
    for value in [
        Value::Null,
        json!([]),
        json!({"revision":null}),
        json!({"revision":1}),
        json!({"revision":""}),
        json!({"revision":"x".repeat(129)}),
        json!({"revision":"😀".repeat(33)}),
        json!({"revision":"\u{0085}"}),
        json!({"revision":"x","extra":true}),
    ] {
        assert!(serde_json::from_value::<contracts::Observe>(value).is_err());
    }
    assert!(serde_json::from_value::<contracts::Observe>(json!({}))
        .unwrap()
        .revision
        .is_none());
    assert_eq!(
        serde_json::from_value::<contracts::Observe>(json!({"revision":"😀".repeat(32)}))
            .unwrap()
            .revision
            .unwrap()
            .len(),
        128
    );
}

#[test]
fn legacy_observation_is_read_only_detached_bounded_and_redacted() {
    let db = Database::in_memory().unwrap();
    db.with(|conn| {
        put_raw(conn, &json!([{"id":"one","name":"Work","updatedAt":0,"settings":{"password":"private-marker","uiProviders":"private-selection"}}]).to_string())?;
        conn.pragma_update(None, "query_only", true)?;
        let first = observe_value(conn, None)?;
        assert_eq!(first["snapshot"]["items"], json!([{"id":"one","name":"Work","updatedAt":0}]));
        assert!(!first.to_string().contains("private"));
        let revision = first["revision"].as_str().unwrap();
        assert_eq!(observe_value(conn, Some(revision))?, json!({"version":1,"revision":revision,"changed":false}));
        assert_eq!(conn.query_row("SELECT count(*) FROM settings WHERE key=?1", [REVISION_KEY], |row| row.get::<_, i64>(0))?, 0);
        Ok(())
    }).unwrap();
}

#[test]
fn native_saves_deletes_aba_and_legacy_writers_invalidate_the_same_read_contract() {
    let db = Database::in_memory().unwrap();
    db.with(|conn| {
        let empty = observe_value(conn, None)?;
        let profiles = super::super::upsert(conn, None, "Work".into(), json!({"theme":"dark"}))?;
        let first = observe_value(conn, None)?;
        let revision = first["revision"].as_str().unwrap();
        assert_ne!(empty["revision"], first["revision"]);
        // Same values and timestamp still get a fresh durable generation.
        super::super::save(conn, &profiles)?;
        assert_eq!(observe_value(conn, Some(revision))?["changed"], true);
        let before_legacy = observe_value(conn, None)?;
        let mut legacy = serde_json::to_value(&profiles)?;
        legacy[0]["name"] = json!("Legacy renamed");
        put_raw(conn, &legacy.to_string())?;
        assert_eq!(
            observe_value(conn, before_legacy["revision"].as_str())?["snapshot"]["items"][0]
                ["name"],
            "Legacy renamed"
        );
        let before_delete = observe_value(conn, None)?;
        super::super::save(conn, &[])?;
        let deleted = observe_value(conn, before_delete["revision"].as_str())?;
        assert_eq!(deleted["snapshot"]["items"], json!([]));
        assert_ne!(deleted["revision"], empty["revision"]);
        Ok(())
    })
    .unwrap();
}

#[test]
fn failed_revision_commit_rolls_back_native_profile_data() {
    let db = Database::in_memory().unwrap();
    db.with(|conn| {
        let profiles = super::super::upsert(conn, None, "Work".into(), json!({"theme":"dark"}))?;
        let before = observe_value(conn, None)?;
        conn.execute_batch(&format!("CREATE TRIGGER reject_profile_revision BEFORE UPDATE ON settings WHEN NEW.key='{REVISION_KEY}' BEGIN SELECT RAISE(FAIL, 'reject test'); END;"))?;
        assert!(super::super::save(conn, &[]).is_err());
        assert_eq!(super::super::load(conn)?[0].id, profiles[0].id);
        assert_eq!(observe_value(conn, before["revision"].as_str())?["changed"], false);
        Ok(())
    }).unwrap();
}

#[test]
fn failed_first_generation_insert_does_not_leave_unversioned_profile_data() {
    let db = Database::in_memory().unwrap();
    db.with(|conn| {
        let before = observe_value(conn, None)?;
        conn.execute_batch(&format!("CREATE TRIGGER reject_profile_revision BEFORE INSERT ON settings WHEN NEW.key='{REVISION_KEY}' BEGIN SELECT RAISE(FAIL, 'reject test'); END;"))?;
        assert!(super::super::upsert(conn, None, "Work".into(), json!({"theme":"dark"})).is_err());
        assert!(super::super::load(conn)?.is_empty());
        assert_eq!(observe_value(conn, before["revision"].as_str())?["changed"], false);
        Ok(())
    }).unwrap();
}

#[test]
fn revision_survives_database_reopen_and_ignores_unrelated_settings() {
    let directory = std::env::temp_dir().join(format!(
        "tunnelde-profile-observation-{}",
        uuid::Uuid::new_v4()
    ));
    let path = directory.join("state.db");
    let revision;
    {
        let db = Database::open(&path).unwrap();
        revision = db
            .with(|conn| {
                super::super::upsert(conn, None, "Work".into(), json!({"theme":"dark"}))?;
                Ok(observe_value(conn, None)?["revision"]
                    .as_str()
                    .unwrap()
                    .to_owned())
            })
            .unwrap();
    }
    {
        let db = Database::open(&path).unwrap();
        db.with(|conn| {
            conn.execute("INSERT OR REPLACE INTO settings(key,value,updated_at) VALUES ('unrelated','private-marker',0)", [])?;
            assert_eq!(observe_value(conn, Some(&revision))?["changed"], false);
            Ok(())
        }).unwrap();
    }
    std::fs::remove_dir_all(directory).unwrap();
}

#[test]
fn invalid_generation_is_bounded_and_private_settings_do_not_enter_legacy_tokens() {
    let db = Database::in_memory().unwrap();
    db.with(|conn| {
        put_raw(
            conn,
            &json!([{"id":"one","name":"Work","updatedAt":0,"settings":{"secret":"one"}}])
                .to_string(),
        )?;
        let initial = observe_value(conn, None)?;
        put_raw(
            conn,
            &json!([{"id":"one","name":"Work","updatedAt":0,"settings":{"secret":"different"}}])
                .to_string(),
        )?;
        assert_eq!(
            observe_value(conn, initial["revision"].as_str())?["changed"],
            false
        );
        for nonce in [
            "private-marker".into(),
            "x".repeat(4096),
            uuid::Uuid::nil().to_string(),
            "550E8400-E29B-41D4-A716-446655440000".to_owned(),
        ] {
            conn.execute(
                "INSERT OR REPLACE INTO settings(key,value,updated_at) VALUES (?1,?2,0)",
                rusqlite::params![REVISION_KEY, nonce],
            )?;
            let error = observe(conn, contracts::Observe::default())
                .err()
                .expect("invalid generation accepted");
            assert!(error.to_string().contains("profiles.invalidStorage"));
            assert!(!error.to_string().contains("private-marker"));
        }
        Ok(())
    })
    .unwrap();
}

#[test]
fn corrupt_metadata_and_storage_are_rejected_without_echoing_private_values() {
    let db = Database::in_memory().unwrap();
    db.with(|conn| {
        let good =
            json!({"id":"one","name":"Work","updatedAt":0,"settings":{"private":"private-marker"}});
        let mut cases = vec![
            "private-marker".into(),
            json!({}).to_string(),
            json!([good.clone(), good.clone()]).to_string(),
            " ".repeat(MAX_STORAGE_BYTES + 1),
            json!(vec![good.clone(); 33]).to_string(),
        ];
        for (key, value) in [
            ("id", json!("")),
            ("id", json!("x".repeat(129))),
            ("name", json!(" Work")),
            ("name", json!("\n")),
            ("name", json!("x".repeat(65))),
            ("updatedAt", json!(-1)),
            ("updatedAt", json!(9_007_199_254_740_992_i64)),
        ] {
            let mut bad = good.clone();
            bad[key] = value;
            cases.push(json!([bad]).to_string());
        }
        for raw in cases {
            put_raw(conn, &raw)?;
            let error = observe(conn, contracts::Observe::default())
                .err()
                .expect("invalid stored metadata accepted");
            assert!(error.to_string().contains("profiles.invalidStorage"));
            assert!(!error.to_string().contains("private-marker"));
        }
        Ok(())
    })
    .unwrap();
}

#[test]
fn maximum_metadata_fits_output_and_emits_real_protocol_fixtures() {
    let db = Database::in_memory().unwrap();
    db.with(|conn| {
        let profiles: Vec<_> = (0..32).map(|i| json!({"id":format!("{i}{}","😀".repeat(30)),"name":format!("{i}{}","中".repeat(60)),"updatedAt":9_007_199_254_740_991_i64,"settings":{}})).collect();
        put_raw(conn,&serde_json::to_string(&profiles)?)?;
        let first=observe_value(conn,None)?;
        assert!(first.to_string().len()<=32*1024);
        let idle=observe_value(conn,first["revision"].as_str())?;
        if let Some(path)=std::env::var_os("TUNNELDE_PROFILE_CONTRACT_OUTPUT") {
            std::fs::write(path,serde_json::to_vec(&json!({"initial":first,"idle":idle}))?)?;
        }
        Ok(())
    }).unwrap();
}

#[test]
fn oversized_native_save_preserves_profile_data_and_generation() {
    let db = Database::in_memory().unwrap();
    db.with(|conn| {
        let original = super::super::upsert(conn, None, "Work".into(), json!({"theme":"dark"}))?;
        let before = observe_value(conn, None)?;
        let oversized = super::super::SettingsProfile {
            id: original[0].id.clone(),
            name: original[0].name.clone(),
            settings: json!({"private": "x".repeat(MAX_STORAGE_BYTES)}),
            updated_at: original[0].updated_at,
        };
        let error = super::super::save(conn, &[oversized]).expect_err("oversized save accepted");
        assert!(error.to_string().contains("profiles.storageTooLarge"));
        assert_eq!(
            serde_json::to_value(super::super::load(conn)?)?,
            serde_json::to_value(original)?
        );
        assert_eq!(
            observe_value(conn, before["revision"].as_str())?["changed"],
            false
        );
        Ok(())
    })
    .unwrap();
}
