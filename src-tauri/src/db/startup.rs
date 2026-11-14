//! Existing storage must pass read-only admission before SQLite can write it.
use std::{io::Read, path::Path, time::Duration};

use rusqlite::{Connection, OpenFlags};

use crate::error::{AppError, AppResult};

pub(super) fn inspect_existing(path: &Path) -> AppResult<()> {
    let mut file = match crate::platform::regular_file::open_read(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return ensure_no_recovery_files(path);
        }
        Err(error) => return Err(error.into()),
    };
    if file.metadata()?.len() == 0 {
        // An interrupted initial creation may leave an empty file. Recovery
        // evidence beside it is not permission to initialize empty storage.
        return ensure_no_recovery_files(path);
    }
    let mut header = [0; 16];
    let valid = match file.read_exact(&mut header) {
        Ok(()) => &header == b"SQLite format 3\0",
        Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => false,
        Err(error) => return Err(error.into()),
    };
    if !valid {
        // Even a read-only SQLite connection may rebuild SHM. Check the raw
        // signature first so an invalid main file cannot touch recovery files.
        return Err(AppError::Db(rusqlite::Error::SqliteFailure(
            rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_NOTADB),
            Some("database header is invalid; original files retained".into()),
        )));
    }
    drop(file);
    let probe = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    probe.busy_timeout(Duration::from_secs(5))?;
    super::schema_version(&probe)?;
    Ok(())
}

fn ensure_no_recovery_files(path: &Path) -> AppResult<()> {
    for suffix in ["-wal", "-shm", "-journal"] {
        let mut sidecar = path.as_os_str().to_owned();
        sidecar.push(suffix);
        if Path::new(&sidecar).try_exists()? {
            return Err(AppError::internal(
                "database is missing or empty but recovery files are present; original files retained",
            ));
        }
    }
    Ok(())
}
