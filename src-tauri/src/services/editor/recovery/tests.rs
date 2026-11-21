use super::{
    contracts::{Draft, Source},
    repository,
};
use crate::{
    db::{self, Database},
    services::files::text_encoding::TextEncoding,
    settings::Settings,
};

fn draft(path: String) -> Draft {
    Draft {
        id: uuid::Uuid::new_v4().to_string(),
        path,
        source: Source::Local,
        baseline: "original\n中文".into(),
        content: "unsaved\n中文“草稿”".into(),
        encoding: Some(TextEncoding::Utf8),
        bom: Some(false),
        baseline_encoding: Some(TextEncoding::Utf8),
        baseline_bom: Some(false),
    }
}

fn enabled(db: &Database) {
    db.with(|conn| {
        db::settings::save(
            conn,
            &Settings {
                editor_draft_recovery: true,
                ..Settings::default()
            },
        )
    })
    .unwrap();
}

#[test]
fn reopens_checkpoint_after_database_exit_without_writing_original() {
    let root = std::env::temp_dir().join(format!("tunnelde-drafts-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&root).unwrap();
    let file = root.join("original.txt");
    std::fs::write(&file, "original\n中文").unwrap();
    let copy = draft(file.to_string_lossy().into_owned());
    let value = serde_json::to_value(&copy).unwrap();
    let database = Database::open(&root.join("state.db")).unwrap();
    enabled(&database);
    let revision = database
        .with(|conn| repository::save(conn, "", vec![copy]))
        .unwrap();
    drop(database);
    let reopened = Database::open(&root.join("state.db")).unwrap();
    reopened
        .with(|conn| {
            let snapshot = repository::read(conn)?;
            assert_eq!(snapshot.revision, revision);
            assert_eq!(serde_json::to_value(&snapshot.drafts[0]).unwrap(), value);
            Ok(())
        })
        .unwrap();
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "original\n中文");
    drop(reopened);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn draft_target_and_strict_baseline_formats_may_differ() {
    let database = Database::in_memory().unwrap();
    enabled(&database);
    let path = std::env::temp_dir()
        .join("replacement.txt")
        .to_string_lossy()
        .into_owned();
    let mut replacement = draft(path);
    replacement.encoding = Some(TextEncoding::Gb18030);
    replacement.bom = Some(false);
    replacement.content = replacement.baseline.clone();
    replacement.baseline_encoding = Some(TextEncoding::Utf8);
    replacement.baseline_bom = Some(true);
    database
        .with(|conn| {
            repository::save(conn, "", vec![replacement.clone()])?;
            assert_eq!(
                repository::read(conn)?.drafts[0].baseline_encoding,
                replacement.baseline_encoding
            );
            Ok(())
        })
        .unwrap();
}

#[test]
fn opt_in_is_required_and_stale_writers_cannot_revive_deleted_drafts() {
    let database = Database::in_memory().unwrap();
    let path = std::env::temp_dir()
        .join("draft.txt")
        .to_string_lossy()
        .into_owned();
    database
        .with(|conn| {
            assert!(repository::save(conn, "", vec![draft(path.clone())]).is_err());
            assert!(repository::read(conn)?.drafts.is_empty());
            Ok(())
        })
        .unwrap();
    enabled(&database);
    database
        .with(|conn| {
            let old = repository::save(conn, "", vec![draft(path.clone())])?;
            repository::clear(conn)?;
            assert!(repository::save(conn, &old, vec![draft(path)]).is_err());
            assert!(repository::read(conn)?.drafts.is_empty());
            Ok(())
        })
        .unwrap();
}

#[test]
fn malformed_snapshot_is_retained_until_explicit_opt_out() {
    let database = Database::in_memory().unwrap();
    enabled(&database);
    database.with(|conn| {
        conn.execute("INSERT INTO settings(key,value,updated_at) VALUES('editor.drafts.v1','bad data',0)", [])?;
        assert!(repository::read(conn).is_err());
        assert!(repository::save(conn, "", Vec::new()).is_err());
        let raw: String = conn.query_row("SELECT value FROM settings WHERE key='editor.drafts.v1'", [], |r| r.get(0))?;
        assert_eq!(raw, "bad data");
        repository::clear(conn)?;
        assert!(repository::read(conn)?.drafts.is_empty());
        Ok(())
    }).unwrap();
}

#[test]
fn rejects_duplicate_ids_relative_paths_and_utf8_overflow_without_losing_checkpoint() {
    let database = Database::in_memory().unwrap();
    enabled(&database);
    database
        .with(|conn| {
            let valid = draft(
                std::env::temp_dir()
                    .join("draft")
                    .to_string_lossy()
                    .into_owned(),
            );
            let revision = repository::save(conn, "", vec![valid.clone()])?;
            assert!(repository::save(conn, &revision, vec![valid.clone(), valid.clone()]).is_err());
            let mut bad = valid.clone();
            bad.path = "relative.txt".into();
            assert!(repository::save(conn, &revision, vec![bad]).is_err());
            let mut bad = valid;
            bad.content = "中".repeat(50_000);
            assert!(repository::save(conn, &revision, vec![bad]).is_err());
            assert_eq!(repository::read(conn)?.revision, revision);
            Ok(())
        })
        .unwrap();
}
