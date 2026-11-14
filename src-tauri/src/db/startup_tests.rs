use super::*;

struct Fixture(std::path::PathBuf);
impl Fixture {
    fn new() -> Self {
        let home = std::env::temp_dir().join(format!("tunnelde-db-start-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&home).unwrap();
        Self(home)
    }
    fn path(&self) -> std::path::PathBuf {
        self.0.join("tunnelde.db")
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        std::fs::remove_dir_all(&self.0).unwrap();
    }
}

#[test]
fn future_schema_rejection_never_changes_database_bytes_or_journal_mode() {
    let fixture = Fixture::new();
    let conn = Connection::open(fixture.path()).unwrap();
    conn.execute_batch("CREATE TABLE retained(value); INSERT INTO retained VALUES ('future');")
        .unwrap();
    conn.pragma_update(None, "user_version", i32::MAX).unwrap();
    drop(conn);
    let before = std::fs::read(fixture.path()).unwrap();
    assert!(Database::open(&fixture.path())
        .is_err_and(|error| error.to_string() == "database schema is newer than this build"));
    assert_eq!(std::fs::read(fixture.path()).unwrap(), before);
    assert_eq!(std::fs::read_dir(&fixture.0).unwrap().count(), 1);
    let conn = Connection::open(fixture.path()).unwrap();
    assert_eq!(
        conn.query_row("PRAGMA journal_mode", [], |row| row.get::<_, String>(0))
            .unwrap(),
        "delete"
    );
}

#[test]
fn future_schema_in_uncheckpointed_wal_is_read_before_granting_write_access() {
    let fixture = Fixture::new();
    let owner = Connection::open(fixture.path()).unwrap();
    owner.pragma_update(None, "journal_mode", "WAL").unwrap();
    owner.pragma_update(None, "wal_autocheckpoint", 0).unwrap();
    owner
        .execute_batch("CREATE TABLE retained(value); INSERT INTO retained VALUES ('future WAL');")
        .unwrap();
    owner.pragma_update(None, "user_version", i32::MAX).unwrap();
    let before = std::fs::read(fixture.path()).unwrap();
    let wal = fixture.0.join("tunnelde.db-wal");
    let before_wal = std::fs::read(&wal).unwrap();
    assert!(Database::open(&fixture.path())
        .is_err_and(|error| error.to_string() == "database schema is newer than this build"));
    assert_eq!(std::fs::read(fixture.path()).unwrap(), before);
    assert_eq!(std::fs::read(&wal).unwrap(), before_wal);
    assert_eq!(
        owner
            .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        i64::from(i32::MAX)
    );
}

#[test]
fn invalid_sqlite_bytes_are_not_repaired_or_reset() {
    let fixture = Fixture::new();
    let before = b"not a sqlite database; preserve this exact original";
    std::fs::write(fixture.path(), before).unwrap();
    let wal = fixture.0.join("tunnelde.db-wal");
    let shm = fixture.0.join("tunnelde.db-shm");
    std::fs::write(&wal, b"retained WAL recovery evidence").unwrap();
    std::fs::write(&shm, b"retained SHM recovery evidence").unwrap();
    assert!(Database::open(&fixture.path()).is_err());
    assert_eq!(std::fs::read(fixture.path()).unwrap(), before);
    assert_eq!(
        std::fs::read(wal).unwrap(),
        b"retained WAL recovery evidence"
    );
    assert_eq!(
        std::fs::read(shm).unwrap(),
        b"retained SHM recovery evidence"
    );
    assert_eq!(std::fs::read_dir(&fixture.0).unwrap().count(), 3);
}

#[test]
fn empty_database_with_recovery_files_is_preserved_but_clean_empty_storage_can_start() {
    let fixture = Fixture::new();
    std::fs::write(fixture.path(), b"").unwrap();
    let wal = fixture.0.join("tunnelde.db-wal");
    std::fs::write(&wal, b"retained recovery evidence").unwrap();
    assert!(Database::open(&fixture.path()).is_err_and(|error| error
        .to_string()
        .contains("empty but recovery files are present")));
    assert_eq!(std::fs::read(fixture.path()).unwrap(), b"");
    assert_eq!(std::fs::read(&wal).unwrap(), b"retained recovery evidence");
    // Use a distinct clean fixture: never remove recovery evidence to start.
    let clean = Fixture::new();
    std::fs::write(clean.path(), b"").unwrap();
    drop(Database::open(&clean.path()).unwrap());
    assert!(!std::fs::read(clean.path()).unwrap().is_empty());
}

#[test]
fn missing_database_does_not_discard_orphaned_recovery_files() {
    for suffix in ["-wal", "-shm", "-journal"] {
        let fixture = Fixture::new();
        let path = fixture.0.join(format!("tunnelde.db{suffix}"));
        std::fs::write(&path, b"retained orphan recovery evidence").unwrap();
        assert!(Database::open(&fixture.path())
            .is_err_and(|error| error.to_string().contains("recovery files are present")));
        assert!(!fixture.path().exists());
        assert_eq!(
            std::fs::read(path).unwrap(),
            b"retained orphan recovery evidence"
        );
        assert_eq!(std::fs::read_dir(&fixture.0).unwrap().count(), 1);
    }
}

#[test]
fn non_regular_database_paths_are_rejected_without_touching_their_contents() {
    let fixture = Fixture::new();
    std::fs::create_dir(fixture.path()).unwrap();
    std::fs::write(fixture.path().join("retained"), b"directory data").unwrap();
    assert!(Database::open(&fixture.path()).is_err());
    assert_eq!(
        std::fs::read(fixture.path().join("retained")).unwrap(),
        b"directory data"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::FileTypeExt;
        let special = Fixture::new();
        assert!(std::process::Command::new("mkfifo")
            .arg(special.path())
            .status()
            .unwrap()
            .success());
        assert!(Database::open(&special.path()).is_err());
        assert!(std::fs::symlink_metadata(special.path())
            .unwrap()
            .file_type()
            .is_fifo());
    }
}

#[test]
fn an_exclusive_writer_is_reported_without_resetting_or_reconfiguring_the_database() {
    let fixture = Fixture::new();
    let owner = Connection::open(fixture.path()).unwrap();
    owner
        .execute_batch("CREATE TABLE retained(value); INSERT INTO retained VALUES ('owned');")
        .unwrap();
    let before = std::fs::read(fixture.path()).unwrap();
    owner.execute_batch("BEGIN EXCLUSIVE").unwrap();
    assert!(Database::open(&fixture.path()).is_err_and(|error| {
        matches!(error, AppError::Db(rusqlite::Error::SqliteFailure(code, _))
            if matches!(code.code, rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked))
    }));
    assert_eq!(std::fs::read(fixture.path()).unwrap(), before);
    owner.execute_batch("ROLLBACK").unwrap();
    drop(owner);
    assert_eq!(std::fs::read_dir(&fixture.0).unwrap().count(), 1);
}

#[test]
fn a_failed_migration_preserves_existing_rows_and_its_original_version() {
    let fixture = Fixture::new();
    let conn = Connection::open(fixture.path()).unwrap();
    conn.execute_batch(
        "CREATE TABLE settings(retained); INSERT INTO settings VALUES ('do not reset');",
    )
    .unwrap();
    drop(conn);
    assert!(Database::open(&fixture.path()).is_err());
    let conn = Connection::open(fixture.path()).unwrap();
    assert_eq!(
        conn.query_row("SELECT retained FROM settings", [], |row| row
            .get::<_, String>(0))
            .unwrap(),
        "do not reset"
    );
    assert_eq!(
        conn.query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        0
    );
    assert_eq!(
        conn.query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE name='hosts'",
            [],
            |row| row.get::<_, i64>(0)
        )
        .unwrap(),
        0
    );
}

#[test]
fn supported_legacy_schema_migrates_and_can_be_reopened_without_losing_rows() {
    let fixture = Fixture::new();
    let conn = Connection::open(fixture.path()).unwrap();
    conn.execute_batch(migrations::MIGRATIONS[0]).unwrap();
    conn.execute_batch("INSERT INTO groups VALUES ('saved', 'Retained group', NULL, 0, 0, 0);")
        .unwrap();
    conn.pragma_update(None, "user_version", 1).unwrap();
    drop(conn);
    for _ in 0..2 {
        let database = Database::open(&fixture.path()).unwrap();
        database
            .with(|conn| {
                assert_eq!(schema_version(conn)?, migrations::MIGRATIONS.len());
                assert_eq!(
                    conn.query_row("SELECT name FROM groups WHERE id='saved'", [], |row| row
                        .get::<_, String>(
                        0
                    ))?,
                    "Retained group"
                );
                assert_eq!(
                    conn.query_row("PRAGMA journal_mode", [], |row| row.get::<_, String>(0))?,
                    "wal"
                );
                Ok(())
            })
            .unwrap();
    }
}
