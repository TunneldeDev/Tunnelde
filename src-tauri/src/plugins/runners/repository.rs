//! Bounded durable transactions. No caller can retain a metadata lock over await.
use std::io::{Read, Write};
use std::path::Path;

use super::{HostContext, Record};
use crate::{
    error::{AppError, AppResult},
    state::AppState,
};
use tauri::Manager;

const MAX_BYTES: usize = 1024 * 1024;
pub(super) const MAX_RECORDS: usize = 256;

fn load(path: &Path) -> AppResult<Vec<Record>> {
    let file = match std::fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };
    let mut bytes = Vec::new();
    file.take((MAX_BYTES + 1) as u64).read_to_end(&mut bytes)?;
    if bytes.len() > MAX_BYTES {
        return Err(AppError::validation("plugin.runners.metadataTooLarge"));
    }
    let records: Vec<Record> = serde_json::from_slice(&bytes)
        .map_err(|_| AppError::validation("plugin.runners.invalidMetadata"))?;
    if records.len() > MAX_RECORDS {
        return Err(AppError::validation("plugin.runners.tooManyTasks"));
    }
    Ok(records)
}

fn save(path: &Path, records: &[Record]) -> AppResult<()> {
    if records.len() > MAX_RECORDS {
        return Err(AppError::validation("plugin.runners.tooManyTasks"));
    }
    let bytes = serde_json::to_vec(records)?;
    if bytes.len() > MAX_BYTES {
        return Err(AppError::validation("plugin.runners.metadataTooLarge"));
    }
    let parent = path
        .parent()
        .ok_or_else(|| AppError::internal("plugin.runners.path"))?;
    std::fs::create_dir_all(parent)?;
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> AppResult<()> {
        let mut file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(&temporary, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

pub(super) fn read(context: &HostContext) -> AppResult<Vec<Record>> {
    access(context, load)
}

pub(super) fn transaction<T>(
    context: &HostContext,
    mutate: impl FnOnce(&mut Vec<Record>) -> AppResult<T>,
) -> AppResult<T> {
    access(context, |path| {
        let mut records = load(path)?;
        let previous = records.clone();
        let value = mutate(&mut records)?;
        if records != previous {
            save(path, &records)?;
        }
        Ok(value)
    })
}

fn access<T>(context: &HostContext, action: impl FnOnce(&Path) -> AppResult<T>) -> AppResult<T> {
    if !super::super::manifest::valid_id(&context.id) {
        return Err(AppError::validation("plugin.invalidId"));
    }
    let state = context.app.state::<AppState>();
    let _commit = state
        .runners
        .metadata
        .lock()
        .unwrap_or_else(|error| error.into_inner());
    let path = state
        .storage
        .dir(crate::storage::layout::Category::Runners)
        .join(format!("{}.json", context.id));
    action(&path)
}

pub(super) fn compare_update(
    context: &HostContext,
    observed: &Record,
    mutate: impl FnOnce(&mut Record) -> AppResult<()>,
) -> AppResult<bool> {
    transaction(context, |records| {
        update_observed(records, observed, mutate)
    })
}

fn update_observed(
    records: &mut [Record],
    observed: &Record,
    mutate: impl FnOnce(&mut Record) -> AppResult<()>,
) -> AppResult<bool> {
    let Some(record) = records
        .iter_mut()
        .find(|record| record.same_revision(observed))
    else {
        return Ok(false);
    };
    mutate(record)?;
    Ok(true)
}

#[cfg(test)]
mod tests;
