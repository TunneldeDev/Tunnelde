use super::{
    contracts::{
        document::{Backup, BackupRequest, Expected, Snapshot, Status, Stored, Update},
        schema::Declaration,
    },
    migration,
    repository::{backups, documents, Repository},
};
use crate::error::{AppError, AppResult};

const INITIAL: &str = "initial";
fn snapshot(schema: &Declaration, doc: Option<&Stored>) -> AppResult<Snapshot> {
    let digest = schema.digest()?;
    let status = match doc {
        None => Status::Ready,
        Some(doc) if doc.schema_version == schema.version && doc.schema_digest == digest => {
            schema
                .validate_values(&doc.values)
                .map_err(|_| AppError::validation("configuration.corrupt"))?;
            Status::Ready
        }
        Some(doc)
            if doc.schema_version < schema.version && migration::prepare(schema, doc).is_ok() =>
        {
            Status::MigrationRequired
        }
        Some(_) => Status::Incompatible,
    };
    Ok(Snapshot {
        schema: schema.clone(),
        schema_digest: digest,
        revision: doc.map_or(INITIAL, |d| &d.revision).into(),
        stored_version: doc.map(|d| d.schema_version),
        stored_digest: doc.map(|d| d.schema_digest.clone()),
        status,
        values: doc.map_or_else(|| schema.defaults(), |d| d.values.clone()),
    })
}
fn check(schema: &Declaration, doc: Option<&Stored>, expected: &Expected) -> AppResult<()> {
    if expected.schema_digest != schema.digest()? {
        return Err(AppError::validation("configuration.schemaChanged"));
    }
    if expected.expected_revision != doc.map_or(INITIAL, |d| &d.revision) {
        return Err(AppError::validation("configuration.conflict"));
    }
    Ok(())
}
pub fn read(repo: &Repository, id: &str, schema: &Declaration) -> AppResult<Snapshot> {
    schema.validate()?;
    repo.read(|conn| snapshot(schema, documents::get(conn, id)?.as_ref()))
}
pub fn update(
    repo: &Repository,
    id: &str,
    schema: &Declaration,
    request: Update,
) -> AppResult<Snapshot> {
    schema.validate()?;
    schema.validate_values(&request.values)?;
    repo.write(|conn| {
        let old = documents::get(Some(conn), id)?;
        check(
            schema,
            old.as_ref(),
            &Expected {
                expected_revision: request.expected_revision,
                schema_digest: request.schema_digest,
            },
        )?;
        if snapshot(schema, old.as_ref())?.status != Status::Ready {
            return Err(AppError::validation("configuration.migrationRequired"));
        }
        let next = Stored {
            revision: uuid::Uuid::new_v4().to_string(),
            schema_version: schema.version,
            schema_digest: schema.digest()?,
            values: request.values,
        };
        documents::put(conn, id, &next)?;
        snapshot(schema, Some(&next))
    })
}
pub fn migrate(
    repo: &Repository,
    id: &str,
    schema: &Declaration,
    expected: Expected,
) -> AppResult<Snapshot> {
    schema.validate()?;
    repo.write(|conn| {
        let old = documents::get(Some(conn), id)?;
        check(schema, old.as_ref(), &expected)?;
        let old = old.ok_or_else(|| AppError::validation("configuration.migrationUnavailable"))?;
        if snapshot(schema, Some(&old))?.status != Status::MigrationRequired {
            return Err(AppError::validation("configuration.migrationUnavailable"));
        }
        let mut next = migration::prepare(schema, &old)?;
        next.revision = uuid::Uuid::new_v4().to_string();
        backups::save(conn, id, &old, "migration")?;
        documents::put(conn, id, &next)?;
        snapshot(schema, Some(&next))
    })
}
pub fn list_backups(repo: &Repository, id: &str) -> AppResult<Vec<Backup>> {
    repo.read(|conn| backups::list(conn, id))
}
pub fn restore(
    repo: &Repository,
    id: &str,
    schema: &Declaration,
    request: BackupRequest,
) -> AppResult<Snapshot> {
    schema.validate()?;
    repo.write(|conn| {
        let old = documents::get(Some(conn), id)?;
        check(
            schema,
            old.as_ref(),
            &Expected {
                expected_revision: request.expected_revision,
                schema_digest: request.schema_digest,
            },
        )?;
        let backup = backups::list(Some(conn), id)?
            .into_iter()
            .find(|b| b.id == request.backup_id)
            .ok_or_else(|| AppError::validation("configuration.backupNotFound"))?;
        if let Some(old) = old {
            backups::save(conn, id, &old, "restore")?;
        }
        let mut next = backup.document;
        next.revision = uuid::Uuid::new_v4().to_string();
        documents::put(conn, id, &next)?;
        snapshot(schema, Some(&next))
    })
}
pub fn delete_backup(
    repo: &Repository,
    id: &str,
    schema: &Declaration,
    request: BackupRequest,
) -> AppResult<Snapshot> {
    schema.validate()?;
    repo.write(|conn| {
        let old = documents::get(Some(conn), id)?;
        check(
            schema,
            old.as_ref(),
            &Expected {
                expected_revision: request.expected_revision,
                schema_digest: request.schema_digest,
            },
        )?;
        backups::remove(conn, id, &request.backup_id)?;
        snapshot(schema, old.as_ref())
    })
}
