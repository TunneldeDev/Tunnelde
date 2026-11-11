use super::contracts::{document::Stored, migration::Operation, schema::Declaration};
use crate::error::{AppError, AppResult};

/// Applies bounded data operations to a detached copy. No plugin code or IO.
pub(super) fn prepare(schema: &Declaration, previous: &Stored) -> AppResult<Stored> {
    let target = schema.digest()?;
    let mut next = previous.clone();
    for _ in 0..=32 {
        if next.schema_version == schema.version && next.schema_digest == target {
            schema.validate_values(&next.values)?;
            return Ok(next);
        }
        let step = schema
            .migrations
            .iter()
            .find(|step| {
                step.from_version == next.schema_version && step.from_digest == next.schema_digest
            })
            .ok_or_else(|| AppError::validation("configuration.migrationUnavailable"))?;
        // Never migrate a newer document backwards or accept a same-version schema drift.
        if step.to_version <= next.schema_version || step.to_version > schema.version {
            return Err(AppError::validation("configuration.migrationUnavailable"));
        }
        for operation in &step.operations {
            match operation {
                Operation::Rename { from, to } => {
                    if next.values.contains_key(to) {
                        return Err(AppError::validation("configuration.migrationConflict"));
                    }
                    let value = next
                        .values
                        .remove(from)
                        .ok_or_else(|| AppError::validation("configuration.migrationConflict"))?;
                    next.values.insert(to.clone(), value);
                }
                Operation::SetDefault { key, value } => {
                    next.values
                        .entry(key.clone())
                        .or_insert_with(|| value.clone());
                }
                Operation::Remove { key } => {
                    if next.values.remove(key).is_none() {
                        return Err(AppError::validation("configuration.migrationConflict"));
                    }
                }
            }
        }
        if serde_json::to_vec(&next.values)?.len() > super::MAX_DOCUMENT {
            return Err(AppError::validation("configuration.limit"));
        }
        next.schema_version = step.to_version;
        next.schema_digest.clone_from(&step.to_digest);
    }
    Err(AppError::validation("configuration.migrationUnavailable"))
}
