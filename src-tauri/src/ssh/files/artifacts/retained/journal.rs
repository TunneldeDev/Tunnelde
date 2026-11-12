use super::{super::*, contracts::*};
use rusqlite::{Connection, Transaction, TransactionBehavior};

fn value(conn: &Connection, key: &str) -> AppResult<Option<String>> {
    conn.query_row("SELECT value FROM settings WHERE key=?1", [key], |row| {
        row.get(0)
    })
    .optional()
    .map_err(Into::into)
}

fn put(conn: &Connection, key: &str, value: String) -> AppResult<()> {
    conn.execute(
        "INSERT INTO settings(key,value,updated_at) VALUES(?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
        rusqlite::params![key, value, crate::models::now_ms()],
    )?;
    Ok(())
}

/// A new generation cannot become visible before the retained receipt is
/// durable. The FULL transaction also serializes late acknowledgements.
fn synced<T>(
    conn: &Connection,
    action: impl FnOnce(&Transaction<'_>) -> AppResult<T>,
) -> AppResult<T> {
    if !conn.is_autocommit() {
        return Err(invalid());
    }
    let previous: i64 = conn.pragma_query_value(None, "synchronous", |row| row.get(0))?;
    conn.pragma_update(None, "synchronous", "FULL")?;
    let result = (|| {
        let tx = Transaction::new_unchecked(conn, TransactionBehavior::Immediate)?;
        let result = action(&tx)?;
        tx.commit()?;
        Ok(result)
    })();
    let restored = conn.pragma_update(None, "synchronous", previous);
    result.and_then(|result| restored.map(|_| result).map_err(Into::into))
}

pub(super) fn load(conn: &Connection, id: &str) -> AppResult<Option<Record>> {
    value(conn, &format!("{PREFIX}{id}"))?
        .map(|raw| {
            let record: Record = serde_json::from_str(&raw)?;
            record.validate()?;
            if record.task_id != id || value(conn, &record.owner_key())?.as_deref() != Some(id) {
                return Err(invalid());
            }
            Ok(record)
        })
        .transpose()
}

fn write_task(conn: &Connection, record: &Record) -> AppResult<()> {
    super::projection::write(conn, record, None)
}

pub(super) fn update_task(conn: &Connection, task: &durable::DurableTransfer) -> AppResult<()> {
    // A stale cleanup failure must neither resurrect a removed receipt nor
    // replace a terminal acknowledgement with an older Unknown projection.
    if let Some(record) = load(conn, &task.id)? {
        super::projection::write(conn, &record, Some(task))?;
    }
    Ok(())
}

pub(super) fn rotate(
    conn: &Connection,
    id: &str,
    to: &Endpoint,
    expected: &ArtifactRecord,
    peer: (&str, &str),
) -> AppResult<ArtifactRecord> {
    synced(conn, |tx| {
        let key = artifact_key(id, to);
        let raw = value(tx, &key)?.ok_or_else(invalid)?;
        let mut next: ArtifactRecord = serde_json::from_str(&raw)?;
        if serde_json::to_vec(&next)? != serde_json::to_vec(expected)? {
            return Err(AppError::validation("sftp.transferBusy"));
        }
        let parent: durable::DurableTransfer =
            serde_json::from_str(&value(tx, &format!("transfer:{id}"))?.ok_or_else(invalid)?)?;
        if parent.id != id
            || parent.retained_creation
            || !matches!(parent.status.as_str(), "running" | "cleanupPending")
            || parent.deleting_source
            || parent.to_host_id.is_none()
            || parent.to_address.is_none()
            || parent.to_host_id.as_deref() != Some(peer.0)
            || parent.to_address.as_deref() != Some(peer.1)
        {
            return Err(invalid());
        }
        let ArtifactRecord::Current {
            path,
            identity,
            archive,
            publication,
            staging: Some(staging),
            ..
        } = &mut next
        else {
            return Err(invalid());
        };
        if *path != to.path
            || identity.is_some()
            || publication.is_some()
            || archive.as_ref().is_some_and(|item| item.pending)
            || staging.prepared
            || staging.opening
            || !staging.creating
        {
            return Err(invalid());
        }
        let total: i64 = tx.query_row(
            "SELECT count(*) FROM settings WHERE instr(key,?1)=1",
            [PREFIX],
            |row| row.get(0),
        )?;
        let owned: i64 = tx.query_row(
            "SELECT count(*) FROM settings WHERE instr(key,?1)=1",
            [format!("transfer-retained-owner:{id}:")],
            |row| row.get(0),
        )?;
        if total >= MAX_TOTAL as i64 || owned >= MAX_PER_TRANSFER as i64 {
            return Err(AppError::validation("sftp.retainedCreationLimit"));
        }
        let record = Record {
            version: 1,
            task_id: uuid::Uuid::new_v4().to_string(),
            parent_id: id.into(),
            name: file_name_of(&to.path),
            plugin_id: parent.plugin_id,
            host_id: parent.to_host_id.unwrap(),
            address: parent.to_address.unwrap(),
            target: to.path.clone(),
            directory: staging_directory(to, id, staging)?.path,
            generation: staging.generation.clone(),
            settlement: Settlement::Unknown,
            updated_at: crate::models::now_ms(),
        };
        record.validate()?;
        if value(tx, &record.owner_key())?.is_some() || value(tx, &record.key())?.is_some() {
            return Err(invalid());
        }
        staging.generation = uuid::Uuid::new_v4().to_string();
        staging.creating = false;
        put(tx, &record.key(), serde_json::to_string(&record)?)?;
        put(tx, &record.owner_key(), record.task_id.clone())?;
        write_task(tx, &record)?;
        put(tx, &key, serde_json::to_string(&next)?)?;
        let digest = format!("{:x}", Sha256::digest(to.path.as_bytes()));
        tx.execute(
            "DELETE FROM settings WHERE key=?1 OR key=?2",
            rusqlite::params![
                format!("transfer-part:{id}:{digest}"),
                format!("transfer-parallel:{id}:{digest}")
            ],
        )?;
        Ok(next)
    })
}

pub(super) fn settle(
    conn: &Connection,
    parent: &str,
    to: &Endpoint,
    directory: &Endpoint,
    created: bool,
) -> AppResult<bool> {
    let index = owner_key(parent, &directory.path);
    let Some(id) = value(conn, &index)? else {
        return Ok(false);
    };
    synced(conn, |tx| {
        if value(tx, &index)?.as_deref() != Some(&id) {
            return Ok(false);
        }
        let mut record = load(tx, &id)?.ok_or_else(invalid)?;
        if record.parent_id != parent
            || record.target != to.path
            || record.directory != directory.path
            || record.owner_key() != index
        {
            return Err(invalid());
        }
        if record.settlement != Settlement::Unknown {
            return Ok(false);
        }
        record.settlement = if created {
            Settlement::Created
        } else {
            Settlement::Rejected
        };
        record.updated_at = crate::models::now_ms();
        put(tx, &record.key(), serde_json::to_string(&record)?)?;
        write_task(tx, &record)?;
        Ok(true)
    })
}

/// Restore independently retained cleanup work even if an older client removed
/// its UI row. Never infer settlement or discard the underlying receipt.
pub(super) fn restore_tasks(conn: &Connection) -> AppResult<()> {
    let mut query =
        conn.prepare("SELECT key,value FROM settings WHERE instr(key,?1)=1 LIMIT ?2")?;
    let raw = query
        .query_map(rusqlite::params![PREFIX, (MAX_TOTAL + 1) as i64], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    if raw.len() > MAX_TOTAL {
        return Err(invalid());
    }
    for (key, raw) in raw {
        let record: Record = serde_json::from_str(&raw)?;
        record.validate()?;
        if record.key() != key
            || value(conn, &record.owner_key())?.as_deref() != Some(&record.task_id)
        {
            return Err(invalid());
        }
        write_task(conn, &record)?;
    }
    Ok(())
}

pub(super) fn remove(conn: &Connection, expected: &Record) -> AppResult<()> {
    synced(conn, |tx| {
        let current = load(tx, &expected.task_id)?.ok_or_else(invalid)?;
        if serde_json::to_vec(&current)? != serde_json::to_vec(expected)?
            || current.settlement == Settlement::Unknown
        {
            return Err(invalid());
        }
        tx.execute(
            "DELETE FROM settings WHERE key=?1 OR key=?2 OR key=?3",
            rusqlite::params![
                current.key(),
                current.owner_key(),
                format!("transfer:{}", current.task_id)
            ],
        )?;
        Ok(())
    })
}
