use super::*;
use crate::ssh::files::native_save::contracts;
use rusqlite::Connection;
pub(super) const CAPACITY: usize = 32;
const MAX_BYTES: usize = 65536;
pub(super) fn encode(record: &Record) -> Result<(String, String)> {
    if !record.valid() {
        return Err(Error::Unrecognized);
    }
    let bytes = serde_json::to_string(record).map_err(|_| Error::Unrecognized)?;
    if bytes.len() > MAX_BYTES {
        return Err(Error::Capacity);
    }
    let digest = contracts::hash(b"tunnelde.files.setup.v1\0", bytes.as_bytes());
    Ok((bytes, digest))
}
pub(in super::super::super) fn read(conn: &Connection, journal_id: &str) -> Result<Vec<Record>> {
    let version: i64 = conn
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|_| Error::Unrecognized)?;
    match version {
        1 | 2 => {
            let exists: bool = conn
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name='native_setups')",
                    [],
                    |row| row.get(0),
                )
                .map_err(|_| Error::Unrecognized)?;
            return if exists {
                Err(Error::Unrecognized)
            } else {
                Ok(Vec::new())
            };
        }
        3 => {}
        _ => return Err(Error::Unrecognized),
    }
    let mut query = conn
        .prepare("SELECT id,revision,value,digest FROM native_setups LIMIT 33")
        .map_err(|_| Error::Unrecognized)?;
    let mut rows = query.query([]).map_err(|_| Error::Unavailable)?;
    let mut records: Vec<Record> = Vec::new();
    while let Some(row) = rows.next().map_err(|_| Error::Unrecognized)? {
        let id: String = row.get(0).map_err(|_| Error::Unrecognized)?;
        let revision: i64 = row.get(1).map_err(|_| Error::Unrecognized)?;
        let bytes = row
            .get_ref(2)
            .map_err(|_| Error::Unrecognized)?
            .as_str()
            .map_err(|_| Error::Unrecognized)?;
        let digest: String = row.get(3).map_err(|_| Error::Unrecognized)?;
        if bytes.len() > MAX_BYTES
            || contracts::hash(b"tunnelde.files.setup.v1\0", bytes.as_bytes()) != digest
        {
            return Err(Error::Unrecognized);
        }
        let record: Record = serde_json::from_str(bytes).map_err(|_| Error::Unrecognized)?;
        if !record.valid()
            || record.journal_id != journal_id
            || record.id != id
            || revision <= 0
            || record.revision != revision as u64
            || records.iter().any(|old| old.plan.overlaps(&record.plan))
        {
            return Err(Error::Unrecognized);
        }
        records.push(record);
    }
    if records.len() > CAPACITY {
        return Err(Error::Capacity);
    }
    Ok(records)
}
pub(super) fn current(conn: &Connection, journal_id: &str, expected: &Record) -> Result<()> {
    read(conn, journal_id)?
        .iter()
        .any(|record| record == expected)
        .then_some(())
        .ok_or(Error::Changed)
}
