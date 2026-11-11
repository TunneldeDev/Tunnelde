use super::{
    contracts::{Empty, Read},
    *,
};
use crate::{
    db::Database,
    error::AppError,
    settings::{Settings, UiProviderSelection},
    settings_profiles::{portable, repository, SettingsProfile, KEY},
};
use serde_json::{json, Value};
use std::cell::Cell;

fn saved(db: &Database, settings: Settings) -> String {
    db.with(|conn| {
        repository::save(
            conn,
            &[SettingsProfile {
                id: "work".into(),
                name: "Work".into(),
                settings: portable(&settings)?,
                updated_at: 1,
            }],
        )?;
        Ok(repository::read(conn)?.revision)
    })
    .unwrap()
}
fn request(revision: &str, offset: usize, limit: usize) -> Read {
    Read {
        id: "work".into(),
        revision: revision.into(),
        offset,
        limit,
    }
}
fn collect(db: &Database, revision: &str, limit: usize) -> (String, Vec<Value>) {
    let mut text = String::new();
    let mut pages = Vec::new();
    let mut offset = 0;
    loop {
        let chunk = read(db, request(revision, offset, limit), || Ok(())).unwrap();
        assert_eq!(chunk.offset, offset);
        assert_eq!(chunk.revision, revision);
        assert!(chunk.text.len() <= limit);
        assert!(serde_json::to_vec(&chunk).unwrap().len() <= MAX_RESPONSE_BYTES);
        pages.push(serde_json::to_value(&chunk).unwrap());
        text.push_str(&chunk.text);
        match chunk.next_offset {
            Some(next) => {
                assert!(next > offset);
                assert_eq!(next, text.len());
                offset = next;
            }
            None => {
                assert_eq!(text.len(), chunk.total_bytes);
                break;
            }
        }
    }
    (text, pages)
}

#[test]
fn requests_reject_null_unknown_fields_and_invalid_byte_ranges() {
    for params in [json!(null), json!([]), json!({"unknown":1})] {
        assert!(serde_json::from_value::<Empty>(params).is_err());
    }
    assert!(serde_json::from_value::<Empty>(json!({})).is_ok());
    let valid = format!("pc1:{}", "a".repeat(64));
    for (offset, limit) in [
        (MAX_CONTENT_BYTES + 1, 4),
        (0, 0),
        (0, 3),
        (0, MAX_CHUNK_BYTES + 1),
    ] {
        assert!(request(&valid, offset, limit).validate().is_err());
    }
    for revision in [
        "p1:old".into(),
        format!("pc1:{}", "G".repeat(64)),
        format!("pc1:{}", "A".repeat(64)),
    ] {
        assert!(request(&revision, 0, 4).validate().is_err());
    }
    for field in ["id", "revision", "offset", "limit"] {
        let mut value = json!({"id":"work","revision":valid,"offset":0,"limit":4});
        value[field] = Value::Null;
        assert!(serde_json::from_value::<Read>(value).is_err());
    }
    let mut value = json!({"id":"work","revision":valid,"offset":0,"limit":4});
    value["unknown"] = true.into();
    assert!(serde_json::from_value::<Read>(value).is_err());
}

#[test]
fn public_content_is_detached_from_private_fields_and_current_selection() {
    let db = Database::in_memory().unwrap();
    let mut settings = Settings {
        theme: "light".into(),
        user_css: "/* 中文😀 */".into(),
        ..Settings::default()
    };
    settings.ui_providers.insert(
        "preferences".into(),
        UiProviderSelection {
            plugin_id: "private-provider".into(),
            view_id: "view".into(),
        },
    );
    let revision = saved(&db, settings);
    let initial = catalogue(&db, || Ok(())).unwrap();
    assert_eq!(initial.active_id, None);
    assert_eq!(initial.items.len(), 1);
    let (text, _) = collect(&db, &revision, 7);
    let public: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(public["appearance"]["theme"], "light");
    assert_eq!(public["appearance"]["userCss"], "/* 中文😀 */");
    assert!(
        !text.contains("private-provider")
            && !text.contains("uiProviders")
            && !text.contains("lastUpdateCheck")
    );
    db.with(|conn| {
        repository::select(conn, Some("work"))?;
        Ok(())
    })
    .unwrap();
    let after = catalogue(&db, || Ok(())).unwrap();
    assert_eq!(after.active_id.as_deref(), Some("work"));
    assert_eq!(after.revision, revision);
    assert_eq!(collect(&db, &revision, MAX_CHUNK_BYTES).0, text);
    assert_eq!(
        crate::services::settings::preferences::profile_values(
            &crate::settings::Settings::default()
        )
        .unwrap()["appearance"]["theme"],
        "system"
    );
}

#[test]
fn revisions_fence_cache_hits_legacy_writes_and_same_content_aba() {
    let db = Database::in_memory().unwrap();
    let revision = saved(&db, Settings::default());
    read(&db, request(&revision, 0, 4), || Ok(())).unwrap(); // warm cache
    db.with(|conn| {
        let mut profiles = repository::read(conn)?.profiles;
        profiles[0].settings["theme"] = "light".into();
        conn.execute(
            "UPDATE settings SET value=?1 WHERE key=?2",
            rusqlite::params![serde_json::to_string(&profiles)?, KEY],
        )?;
        Ok(())
    })
    .unwrap();
    assert_eq!(
        read(&db, request(&revision, 0, 4), || Ok(()))
            .err()
            .unwrap()
            .to_string(),
        "profiles.conflict"
    );
    let second = saved(&db, Settings::default());
    assert_ne!(second, revision);
    assert_eq!(
        read(&db, request(&revision, 0, 4), || Ok(()))
            .err()
            .unwrap()
            .to_string(),
        "profiles.conflict"
    );
    db.with(|conn| {
        repository::save(conn, &[])?;
        Ok(())
    })
    .unwrap();
    let empty = catalogue(&db, || Ok(())).unwrap();
    assert_eq!(
        read(&db, request(&empty.revision, 0, 4), || Ok(()))
            .err()
            .unwrap()
            .to_string(),
        "profiles.notFound"
    );
}

#[test]
fn invalid_legacy_contents_do_not_break_metadata_or_get_silently_repaired() {
    let db = Database::in_memory().unwrap();
    let revision = saved(
        &db,
        Settings {
            user_css: " ".repeat(200_001),
            ..Settings::default()
        },
    );
    assert_eq!(catalogue(&db, || Ok(())).unwrap().items.len(), 1);
    assert_eq!(
        read(&db, request(&revision, 0, 4), || Ok(()))
            .err()
            .unwrap()
            .to_string(),
        "profiles.content.invalidContent"
    );
    assert_eq!(
        db.with(
            |conn| Ok(repository::read(conn)?.profiles[0].settings["userCss"]
                .as_str()
                .unwrap()
                .len())
        )
        .unwrap(),
        200_001
    );
}

#[test]
fn catalogue_checks_release_the_shared_database_between_stages() {
    let db = Database::in_memory().unwrap();
    let revision = saved(&db, Settings::default());
    let checks = Cell::new(0);
    let response = catalogue(&db, || {
        db.with(|_| Ok(()))?;
        checks.set(checks.get() + 1);
        Ok(())
    })
    .unwrap();
    assert!(checks.get() >= 3);
    assert_eq!(response.revision, revision);
    assert_eq!(response.items.len(), 1);
}

#[test]
fn revocation_and_cancellation_are_checked_after_loading_and_before_response() {
    let db = Database::in_memory().unwrap();
    let revision = saved(&db, Settings::default());
    for stop in [0, 1, 2] {
        let count = Cell::new(0);
        let result = read(&db, request(&revision, 0, 4), || {
            // Reentrant access proves projection/checks do not retain DB locks.
            if count.get() > 0 {
                db.with(|_| Ok(()))?;
            }
            let current = count.get();
            count.set(current + 1);
            if current >= stop {
                Err(AppError::validation("plugin.api.cancelled"))
            } else {
                Ok(())
            }
        });
        assert_eq!(result.err().unwrap().to_string(), "plugin.api.cancelled");
    }
}

#[test]
fn segments_handle_eof_multibyte_boundaries_and_escaping_budget() {
    let revision = format!("pc1:{}", "a".repeat(64));
    let text = "😀中";
    let chunk = super::read::segment(text, request(&revision, 0, 4)).unwrap();
    assert_eq!(chunk.text, "😀");
    assert_eq!(chunk.next_offset, Some(4));
    let eof = super::read::segment(text, request(&revision, text.len(), 4)).unwrap();
    assert_eq!(eof.text, "");
    assert_eq!(eof.next_offset, None);
    for offset in [1, 2, 3, 5, 6, 8] {
        assert!(super::read::segment(text, request(&revision, offset, 4)).is_err());
    }
    let controls = "\u{0001}".repeat(MAX_CHUNK_BYTES);
    let chunk = super::read::segment(&controls, request(&revision, 0, MAX_CHUNK_BYTES)).unwrap();
    assert!(chunk.next_offset.is_some());
    assert!(serde_json::to_vec(&chunk).unwrap().len() <= MAX_RESPONSE_BYTES);
    assert!(!chunk.text.is_empty());
}

#[test]
fn full_native_storage_bound_remains_readable_without_a_new_import_file_limit() {
    let db = Database::in_memory().unwrap();
    saved(&db, Settings::default());
    db.with(|conn| {
        let raw: String =
            conn.query_row("SELECT value FROM settings WHERE key=?1", [KEY], |r| {
                r.get(0)
            })?;
        let padded = format!(
            "{}{}",
            " ".repeat(super::super::observation::MAX_STORAGE_BYTES - raw.len()),
            raw
        );
        conn.execute(
            "UPDATE settings SET value=?1 WHERE key=?2",
            rusqlite::params![padded, KEY],
        )?;
        Ok(())
    })
    .unwrap();
    let cat = catalogue(&db, || Ok(())).unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&collect(&db, &cat.revision, MAX_CHUNK_BYTES).0).unwrap()
            ["appearance"]["theme"],
        "system"
    );
}

#[test]
fn large_public_body_emits_actual_segmented_sdk_interoperability_fixture() {
    let db = Database::in_memory().unwrap();
    // 1.2MiB once JSON-escaped: larger than a whole public transport response,
    // while the native CSS remains within its 200000-byte preference bound.
    let revision = saved(
        &db,
        Settings {
            user_css: format!("{}{}", "\u{0001}".repeat(196_000), "中😀".repeat(500)),
            ..Settings::default()
        },
    );
    let (text, pages) = collect(&db, &revision, MAX_CHUNK_BYTES);
    assert!(text.len() > super::super::MAX_FILE_BYTES);
    assert!(pages.len() > 1);
    let values: Value = serde_json::from_str(&text).unwrap();
    let cat = catalogue(&db, || Ok(())).unwrap();
    if let Some(path) = std::env::var_os("TUNNELDE_PROFILE_CONTENT_OUTPUT") {
        std::fs::write(
            path,
            serde_json::to_vec(&json!({"catalogue":cat,"pages":pages,"values":values})).unwrap(),
        )
        .unwrap();
    }
}
