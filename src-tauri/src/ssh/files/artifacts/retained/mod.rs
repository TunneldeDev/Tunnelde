//! Isolate an unacknowledged MKDIR before assigning a fresh staging generation.
//! Its independent cleanup task survives main-task completion and removal.
use super::*;
mod contracts;
mod journal;
mod projection;
use contracts::{invalid, Settlement};

#[cfg(test)]
mod tests;

pub(in crate::ssh::files) fn update_task(
    conn: &rusqlite::Connection,
    task: &durable::DurableTransfer,
) -> AppResult<()> {
    journal::update_task(conn, task)
}

pub(in crate::ssh::files) fn restore_tasks(conn: &rusqlite::Connection) -> AppResult<()> {
    journal::restore_tasks(conn)
}

pub(in crate::ssh::files) fn restore_task(conn: &rusqlite::Connection, id: &str) -> AppResult<()> {
    if let Some(record) = journal::load(conn, id)? {
        projection::write(conn, &record, None)?;
    }
    Ok(())
}

pub(in crate::ssh::files) fn protect_remove(
    conn: &rusqlite::Connection,
    id: &str,
) -> AppResult<()> {
    if let Some(record) = journal::load(conn, id)? {
        return Err(AppError::TransferCreationUnconfirmed {
            path: record.directory,
        });
    }
    Ok(())
}

pub(super) fn rotate(
    app: &AppHandle,
    id: &str,
    to: &Endpoint,
    record: &mut Option<ArtifactRecord>,
) -> AppResult<()> {
    let Some(staging) = remote_staging(record.as_ref()) else {
        return Ok(());
    };
    if staging.prepared || !staging.creating {
        return Ok(());
    }
    let parent = durable::Journal::get(app, id)?;
    let peer = app
        .state::<AppState>()
        .ssh
        .list()
        .into_iter()
        .find(|peer| Some(&peer.id) == to.session.as_ref())
        .ok_or_else(invalid)?;
    if parent.to_host_id.as_deref() != Some(&peer.host_id)
        || parent.to_address.as_deref() != Some(&peer.address)
    {
        return Err(invalid());
    }
    let next = app.state::<AppState>().db.with(|conn| {
        journal::rotate(
            conn,
            id,
            to,
            record.as_ref().unwrap(),
            (&peer.host_id, &peer.address),
        )
    })?;
    *record = Some(next);
    let _ = app.emit("sftp://changed", ());
    Ok(())
}

pub(super) fn settle(
    conn: &rusqlite::Connection,
    id: &str,
    to: &Endpoint,
    directory: &Endpoint,
    created: bool,
) -> AppResult<bool> {
    journal::settle(conn, id, to, directory, created)
}

/// Disposal may be offline. This only retains previously persisted intent;
/// it does not grant filesystem authority or redirect a remote operation.
pub(in crate::ssh::files) fn detach_for_cleanup(
    app: &AppHandle,
    task: &durable::DurableTransfer,
) -> AppResult<()> {
    let records = app.state::<AppState>().db.with(|conn| {
        let mut query = conn.prepare("SELECT value FROM settings WHERE instr(key,?1)=1 AND json_type(value,'$.staging')='object' AND coalesce(json_extract(value,'$.staging.prepared'),0)=0 AND coalesce(json_extract(value,'$.staging.creating'),1)=1 LIMIT ?2")?;
        let raw = query.query_map(rusqlite::params![format!("transfer-artifact:{}:", task.id), (contracts::MAX_PER_TRANSFER + 1) as i64], |row| row.get::<_,String>(0))?.collect::<Result<Vec<_>,_>>()?;
        if raw.len() > contracts::MAX_PER_TRANSFER { return Err(AppError::validation("sftp.retainedCreationLimit")); }
        raw.into_iter().map(|raw| serde_json::from_str::<ArtifactRecord>(&raw).map_err(Into::into)).collect::<AppResult<Vec<_>>>()
    })?;
    for record in records {
        let path = match &record {
            ArtifactRecord::Current { path, .. } => path.clone(),
            _ => return Err(invalid()),
        };
        let to = Endpoint {
            session: Some("metadata-only".into()),
            path,
        };
        app.state::<AppState>().db.with(|conn| {
            journal::rotate(
                conn,
                &task.id,
                &to,
                &record,
                (
                    task.to_host_id.as_deref().ok_or_else(invalid)?,
                    task.to_address.as_deref().ok_or_else(invalid)?,
                ),
            )
        })?;
    }
    Ok(())
}

/// Missing paths cannot settle Unknown. Only an explicit rejection permits
/// removing metadata without remote I/O; Created permits empty-directory RMDIR.
pub(in crate::ssh::files) async fn cleanup(
    app: &AppHandle,
    task: &durable::DurableTransfer,
    observation: &native_save::runtime::MutationObservation,
) -> AppResult<()> {
    let record = app
        .state::<AppState>()
        .db
        .with(|conn| journal::load(conn, &task.id))?
        .ok_or_else(invalid)?;
    if !task.retained_creation
        || task.to_host_id.as_deref() != Some(&record.host_id)
        || task.to_address.as_deref() != Some(&record.address)
        || task.to_path != record.target
    {
        return Err(invalid());
    }
    match record.settlement {
        Settlement::Unknown => {
            return Err(AppError::TransferCreationUnconfirmed {
                path: record.directory,
            })
        }
        Settlement::Rejected => {} // May be a foreign collision; never inspect or remove it.
        Settlement::Created => {
            let session_id = durable::resolve_session(
                app,
                Some(&record.host_id),
                task.to_session.as_deref(),
                Some(&record.address),
            )?
            .ok_or_else(invalid)?;
            let sftp = admission::open(app, &session_id, &[&record.directory]).await?;
            let result = cleanup_created(&sftp, &record.directory, observation).await;
            let _ = tokio::time::timeout(std::time::Duration::from_secs(2), sftp.close()).await;
            result?;
        }
    }
    app.state::<AppState>()
        .db
        .with(|conn| journal::remove(conn, &record))?;
    let _ = app.emit("sftp://changed", ());
    Ok(())
}

async fn cleanup_created(
    sftp: &SftpSession,
    path: &str,
    observation: &native_save::runtime::MutationObservation,
) -> AppResult<()> {
    let cancel = AtomicBool::new(false);
    match sftp.symlink_metadata(path).await {
        Ok(metadata) => staging::validate_directory(sftp, path, metadata, &cancel, true).await?,
        Err(error) if staging::missing(&error) => return Ok(()),
        Err(error) => return Err(map_sftp(error)),
    }
    // No writer or file OPEN can have started in this retired generation.
    // RMDIR refuses foreign contents and never recursively deletes anything.
    staging::cleanup_directory(
        sftp,
        &Endpoint {
            session: Some("settled".into()),
            path: path.into(),
        },
        false,
        observation,
    )
    .await
}
