use super::*;
use crate::db::Database;

#[test]
fn final_guard_runs_before_any_write_and_companion_failure_stays_atomic() {
    Database::in_memory().unwrap().with(|conn| {
        let initial = Settings::default();
        let expected = save(conn,&initial)?;
        let mut changed = initial.clone(); changed.theme = "dark".into();
        let current = save(conn,&changed)?;
        let mut proposed = changed.clone(); proposed.theme = "light".into();
        // If the guard were late, this trigger would mask the stale revision.
        conn.execute_batch("CREATE TRIGGER reject_preferences BEFORE UPDATE ON settings WHEN NEW.key='app' BEGIN SELECT RAISE(FAIL,'guard ran too late'); END;")?;
        let error = save_guarded(conn,&proposed,|tx| {
            if revision(tx,&changed)? != expected { return Err(crate::error::AppError::validation("preferences.staleRevision")); }
            Ok(())
        }, |_|Ok(())).unwrap_err();
        assert_eq!(error.to_string(),"preferences.staleRevision");
        assert_eq!(revision(conn,&changed)?,current);
        assert_eq!(crate::db::settings::load(conn)?.theme,"dark");
        conn.execute_batch("DROP TRIGGER reject_preferences")?;
        assert!(save_guarded(conn,&proposed,|_|Ok(()),|_|Err(crate::error::AppError::validation("profiles.conflict"))).is_err());
        assert_eq!(revision(conn,&changed)?,current);
        assert_eq!(crate::db::settings::load(conn)?.theme,"dark");
        Ok(())
    }).unwrap();
}

#[test]
fn companion_failure_rolls_back_preferences_revision_and_selection() {
    Database::in_memory()
        .unwrap()
        .with(|conn| {
            let initial = Settings::default();
            let before = save(conn, &initial)?;
            conn.execute(
                "INSERT INTO settings(key,value,updated_at) VALUES('test.profile.selection','old',0)",
                [],
            )?;
            let mut next = initial.clone();
            next.theme = "light".into();
            let result = save_with(conn, &next, |tx| {
                tx.execute("UPDATE settings SET value='new' WHERE key='test.profile.selection'", [])?;
                Err(crate::error::AppError::validation("profiles.conflict"))
            });
            assert_eq!(result.err().unwrap().to_string(), "profiles.conflict");
            assert_eq!(revision(conn, &initial)?, before);
            assert_eq!(crate::db::settings::load(conn)?.theme, initial.theme);
            let selected: String = conn.query_row(
                "SELECT value FROM settings WHERE key='test.profile.selection'", [], |row| row.get(0),
            )?;
            assert_eq!(selected, "old");
            let after = save_with(conn, &next, |tx| {
                tx.execute("UPDATE settings SET value='new' WHERE key='test.profile.selection'", [])?;
                Ok(())
            })?;
            assert_ne!(after, before);
            assert_eq!(crate::db::settings::load(conn)?.theme, next.theme);
            Ok(())
        })
        .unwrap();
}

#[test]
fn legacy_reads_do_not_write_and_every_commit_prevents_aba() {
    let database = Database::in_memory().unwrap();
    database
        .with(|conn| {
            let initial = Settings::default();
            let legacy = revision(conn, &initial)?;
            assert!(legacy.starts_with("legacy:"));
            assert_eq!(legacy, revision(conn, &initial)?);
            assert_eq!(
                0,
                conn.query_row("SELECT count(*) FROM settings", [], |row| row
                    .get::<_, i64>(0))?
            );
            let first = save(conn, &initial)?;
            let mut other = initial.clone();
            other.theme = "dark".into();
            let second = save(conn, &other)?;
            let third = save(conn, &initial)?;
            let fourth = save(conn, &initial)?;
            assert_eq!(
                4,
                [&first, &second, &third, &fourth]
                    .into_iter()
                    .collect::<std::collections::HashSet<_>>()
                    .len()
            );
            assert_ne!(legacy, first);
            assert_eq!(fourth, revision(conn, &crate::db::settings::load(conn)?)?);
            Ok(())
        })
        .unwrap();
}

#[test]
fn revision_failure_rolls_back_the_settings_too() {
    let database = Database::in_memory().unwrap();
    database
        .with(|conn| {
            let initial = Settings::default();
            let before = save(conn, &initial)?;
            conn.execute_batch(
                "CREATE TRIGGER fail_revision BEFORE UPDATE ON settings
            WHEN NEW.key = 'settings.preferences.revision.v1'
            BEGIN SELECT RAISE(FAIL, 'test revision failure'); END;",
            )?;
            let mut next = initial.clone();
            next.theme = "dark".into();
            assert!(save(conn, &next).is_err());
            assert_eq!(before, revision(conn, &initial)?);
            assert_eq!(initial.theme, crate::db::settings::load(conn)?.theme);
            Ok(())
        })
        .unwrap();
}

#[test]
fn revision_survives_database_reopen() {
    let root = std::env::temp_dir().join(format!("tunnelde-settings-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&root).unwrap();
    let path = root.join("state.db");
    let initial = Settings::default();
    let before = {
        let database = Database::open(&path).unwrap();
        database.with(|conn| save(conn, &initial)).unwrap()
    };
    {
        let database = Database::open(&path).unwrap();
        assert_eq!(
            before,
            database
                .with(|conn| revision(conn, &crate::db::settings::load(conn)?))
                .unwrap()
        );
    }
    std::fs::remove_dir_all(root).unwrap();
}
