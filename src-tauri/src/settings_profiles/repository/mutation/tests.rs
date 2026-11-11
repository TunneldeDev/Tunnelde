use super::*;
use crate::{db::Database, settings::Settings};
fn one() -> SettingsProfile {
    SettingsProfile {
        id: "work".into(),
        name: "Work".into(),
        updated_at: 1,
        settings: crate::settings_profiles::portable(&Settings::default()).unwrap(),
    }
}
fn planned(db: &Database, profiles: &[SettingsProfile]) -> Prepared {
    prepare(capture(db).unwrap(), profiles).unwrap()
}

#[test]
fn raw_cas_catches_legacy_same_metadata_body_changes_and_native_aba() {
    let db = Database::in_memory().unwrap();
    db.with(|conn| super::super::save(conn, &[one()])).unwrap();
    let pending = planned(&db, &[]);
    db.with(|conn| {
        let mut changed = one();
        changed.settings["theme"] = "light".into();
        conn.execute(
            "UPDATE settings SET value=?1 WHERE key=?2",
            params![serde_json::to_string(&[changed])?, KEY],
        )?;
        assert_eq!(
            pending.persist(conn, || Ok(())).unwrap_err().to_string(),
            "profiles.conflict"
        );
        Ok(())
    })
    .unwrap();
    let pending = planned(&db, &[]);
    db.with(|conn| {
        let current = super::super::read(conn)?.profiles;
        super::super::save(conn, &current)?;
        assert_eq!(
            pending.persist(conn, || Ok(())).unwrap_err().to_string(),
            "profiles.conflict"
        );
        assert_eq!(super::super::read(conn)?.profiles.len(), 1);
        Ok(())
    })
    .unwrap();
}

#[test]
fn missing_and_literal_empty_rows_are_not_the_same_cas_source() {
    let db = Database::in_memory().unwrap();
    let pending = planned(&db, &[one()]);
    db.with(|conn| {
        conn.execute(
            "INSERT INTO settings(key,value,updated_at) VALUES(?1,'[]',0)",
            [KEY],
        )?;
        assert!(pending.persist(conn, || Ok(())).is_err());
        assert!(super::super::read(conn)?.profiles.is_empty());
        Ok(())
    })
    .unwrap();
}

#[test]
fn cancellation_or_companion_failure_rolls_back_body_nonce_and_selection() {
    let db = Database::in_memory().unwrap();
    db.with(|conn| {
        super::super::save(conn, &[one()])?;
        select(conn, Some("work"))
    })
    .unwrap();
    let pending = planned(&db, &[]);
    let before = capture(&db).unwrap().decode().unwrap().revision;
    db.with(|conn| {
        assert!(pending.persist(conn, || Err(AppError::validation("cancelled"))).is_err());
        assert_eq!(super::super::read(conn)?.revision, before);
        conn.execute_batch("CREATE TRIGGER fail_selection BEFORE DELETE ON settings WHEN OLD.key='settings.profiles.active.v1' BEGIN SELECT RAISE(FAIL,'injected'); END;")?;
        assert!(pending.persist(conn, || Ok(())).is_err());
        assert_eq!(super::super::read(conn)?.revision, before);
        assert_eq!(active(conn)?.as_deref(), Some("work"));
        conn.execute_batch("DROP TRIGGER fail_selection")?;
        pending.persist(conn, || Ok(()))?;
        assert_eq!(super::super::read(conn)?.revision, pending.revision);
        assert!(active(conn)?.is_none());
        Ok(())
    }).unwrap();
}

#[test]
fn commit_preserves_selection_changed_after_capture_when_profile_is_retained() {
    let db = Database::in_memory().unwrap();
    db.with(|conn| super::super::save(conn, &[one()])).unwrap();
    let pending = planned(&db, &[one()]);
    db.with(|conn| {
        select(conn, Some("work"))?;
        pending.persist(conn, || Ok(()))?;
        assert_eq!(active(conn)?.as_deref(), Some("work"));
        assert_eq!(super::super::read(conn)?.revision, pending.revision);
        Ok(())
    })
    .unwrap();
}
