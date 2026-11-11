use super::*;
use crate::{db::Database, settings::Settings};

fn one() -> SettingsProfile {
    SettingsProfile {
        id: "work".into(),
        name: "Work".into(),
        updated_at: 1,
        settings: super::super::portable(&Settings::default()).unwrap(),
    }
}

#[test]
fn captured_body_and_selection_are_immutable_after_database_changes() {
    let db = Database::in_memory().unwrap();
    let captured = db
        .with(|conn| {
            save(conn, &[one()])?;
            select(conn, Some("work"))?;
            capture(conn)
        })
        .unwrap();
    db.with(|conn| save(conn, &[])).unwrap();
    let previous = captured.decode().unwrap();
    assert_eq!(previous.profiles.len(), 1);
    assert_eq!(previous.profiles[0].id, "work");
    assert_eq!(previous.active_id.as_deref(), Some("work"));
    db.with(|conn| {
        let current = read(conn)?;
        assert_ne!(current.revision, previous.revision);
        assert!(current.profiles.is_empty());
        assert!(current.active_id.is_none());
        Ok(())
    })
    .unwrap();
}

#[test]
fn legacy_native_body_keeps_the_original_total_storage_limit() {
    Database::in_memory()
        .unwrap()
        .with(|conn| {
            let mut profile = one();
            profile.settings["userCss"] = " ".repeat(super::super::MAX_FILE_BYTES + 1).into();
            save(conn, &[profile])?;
            let saved = read(conn)?;
            assert_eq!(saved.profiles.len(), 1);
            assert!(
                saved.profiles[0].settings["userCss"]
                    .as_str()
                    .unwrap()
                    .len()
                    > super::super::MAX_FILE_BYTES
            );
            Ok(())
        })
        .unwrap();
}

#[test]
fn legacy_reads_are_read_only_and_revisions_cover_content_and_aba() {
    Database::in_memory()
        .unwrap()
        .with(|conn| {
            let initial = read(conn)?;
            assert!(initial.profiles.is_empty() && initial.active_id.is_none());
            assert_eq!(
                conn.query_row("SELECT count(*) FROM settings", [], |row| row
                    .get::<_, i64>(0))?,
                0
            );
            save(conn, &[one()])?;
            let first = read(conn)?.revision;
            save(conn, &[one()])?;
            assert_ne!(first, read(conn)?.revision);
            let before = read(conn)?.revision;
            let mut changed = one();
            changed.settings["theme"] = "light".into();
            // Legacy writer changes body without updating nonce or timestamp.
            conn.execute(
                "UPDATE settings SET value=?1 WHERE key=?2",
                params![serde_json::to_string(&[changed])?, KEY],
            )?;
            assert_ne!(before, read(conn)?.revision);
            assert_eq!(
                check(conn, &before).err().unwrap().to_string(),
                "profiles.conflict"
            );
            Ok(())
        })
        .unwrap();
}

#[test]
fn rename_preserves_selection_and_deletion_clears_it_without_touching_settings() {
    Database::in_memory().unwrap().with(|conn| {
        let initial = Settings::default(); crate::db::settings::save(conn, &initial)?;
        save(conn, &[one()])?; select(conn, Some("work"))?;
        let mut renamed = one(); renamed.name = "Renamed".into(); save(conn, &[renamed])?;
        assert_eq!(read(conn)?.active_id.as_deref(), Some("work"));
        conn.execute_batch("CREATE TRIGGER fail_selection BEFORE DELETE ON settings WHEN OLD.key='settings.profiles.active.v1' BEGIN SELECT RAISE(FAIL,'selection failure'); END;")?;
        assert!(save(conn, &[]).is_err());
        assert_eq!(read(conn)?.profiles.len(), 1);
        assert_eq!(read(conn)?.active_id.as_deref(), Some("work"));
        conn.execute_batch("DROP TRIGGER fail_selection")?;
        save(conn, &[])?;
        assert!(read(conn)?.active_id.is_none());
        assert_eq!(serde_json::to_value(crate::db::settings::load(conn)?)?,serde_json::to_value(initial)?);
        Ok(())
    }).unwrap();
}

#[test]
fn invalid_or_oversized_storage_is_rejected_without_repairing_it() {
    Database::in_memory()
        .unwrap()
        .with(|conn| {
            for value in [
                serde_json::json!([one(), one()]).to_string(),
                "{}".into(),
                "[".into(),
                serde_json::to_string(&vec![one(); 33])?,
            ] {
                conn.execute(
                    "INSERT OR REPLACE INTO settings(key,value,updated_at) VALUES(?1,?2,0)",
                    params![KEY, value],
                )?;
                assert_eq!(
                    read(conn).err().unwrap().to_string(),
                    "profiles.invalidStorage"
                );
                assert_eq!(
                    conn.query_row("SELECT value FROM settings WHERE key=?1", [KEY], |row| {
                        row.get::<_, String>(0)
                    })?,
                    value
                );
            }
            conn.execute(
                "UPDATE settings SET value=zeroblob(?1) WHERE key=?2",
                params![(observation::MAX_STORAGE_BYTES + 1) as i64, KEY],
            )?;
            assert_eq!(
                read(conn).err().unwrap().to_string(),
                "profiles.invalidStorage"
            );
            Ok(())
        })
        .unwrap();
}

#[test]
fn active_identity_survives_reopen_and_import_detach_is_transactional() {
    let root = std::env::temp_dir().join(format!(
        "tunnelde-profile-selection-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir_all(&root).unwrap();
    let path = root.join("state.db");
    {
        Database::open(&path)
            .unwrap()
            .with(|conn| {
                save(conn, &[one()])?;
                select(conn, Some("work"))
            })
            .unwrap();
    }
    {
        Database::open(&path)
            .unwrap()
            .with(|conn| {
                assert_eq!(read(conn)?.active_id.as_deref(), Some("work"));
                {
                    let tx = conn.unchecked_transaction()?;
                    select(&tx, None)?;
                }
                assert_eq!(read(conn)?.active_id.as_deref(), Some("work"));
                select(conn, None)?;
                assert!(read(conn)?.active_id.is_none());
                Ok(())
            })
            .unwrap();
    }
    std::fs::remove_dir_all(root).unwrap();
}
