use super::contracts::*;
use crate::{
    error::{AppError, AppResult},
    storage::{
        config::Config,
        layout::{Category, Paths, CATEGORIES},
    },
};
use sha2::{Digest, Sha256};
use std::path::Path;
pub(super) const MAX_RESPONSE: usize = 128 * 1024;
pub(super) fn invalid() -> AppError {
    AppError::validation("storage.locations.invalidState")
}
pub(super) fn text(value: &str) -> AppResult<String> {
    if value.is_empty() || value.len() > 4096 || value.chars().any(char::is_control) {
        return Err(invalid());
    }
    Ok(value.to_owned())
}
pub(super) fn path(value: &Path) -> AppResult<String> {
    if !value.is_absolute() {
        return Err(invalid());
    }
    text(value.to_str().ok_or_else(invalid)?)
}
pub(super) fn changes(changes: &[crate::storage::config::Change]) -> AppResult<Vec<Change>> {
    if changes.is_empty() || changes.len() > 8 {
        return Err(invalid());
    }
    let mut categories = std::collections::HashSet::new();
    changes
        .iter()
        .map(|item| {
            if !categories.insert(item.category) {
                return Err(invalid());
            }
            Ok(Change {
                category: item.category,
                target: path(&item.target)?,
                migrate: item.migrate,
            })
        })
        .collect()
}
pub(super) fn recovery_required(paths: &Paths, config: &Config) -> AppResult<bool> {
    use crate::storage::{layout, migration, restore};
    if config.last_error.is_some() {
        return Ok(true);
    }
    if let Some(pending) = &config.pending {
        for change in &pending.changes {
            if layout::metadata(&migration::stage(change, &pending.id)?)?.is_some()
                || layout::metadata(&change.target.join(migration::MARKER))?.is_some()
                || (restore::is_default(paths, change)? && restore::pending(change, &pending.id)?)
            {
                return Ok(true);
            }
        }
    }
    Ok(false)
}
pub(super) fn snapshot(paths: &Paths, config: &Config) -> AppResult<Snapshot> {
    let locations = CATEGORIES
        .into_iter()
        .map(|category| {
            Ok(Location {
                category,
                path: path(paths.dirs.get(&category).ok_or_else(invalid)?)?,
                default_path: path(paths.defaults.get(&category).ok_or_else(invalid)?)?,
                overridden: category == Category::Plugins && paths.plugins_override,
            })
        })
        .collect::<AppResult<Vec<_>>>()?;
    let pending = config
        .pending
        .as_ref()
        .map(|pending| {
            if uuid::Uuid::parse_str(&pending.id).is_err() {
                return Err(invalid());
            }
            Ok(Plan {
                changes: changes(&pending.changes)?,
            })
        })
        .transpose()?;
    // Hash private configuration state too, but return only known public metadata.
    // In particular, replacing an identically displayed pending plan changes UUID.
    let mut snapshot = Snapshot {
        version: 1,
        revision: String::new(),
        locations,
        pending,
        recovery_required: recovery_required(paths, config)?,
    };
    let mut hash = Sha256::new();
    hash.update(b"tunnelde.storage-locations.v1\0");
    hash.update(serde_json::to_vec(config)?);
    hash.update(serde_json::to_vec(&snapshot)?);
    snapshot.revision = format!("l1:{:x}", hash.finalize());
    if serde_json::to_vec(&snapshot)?.len() > MAX_RESPONSE - 1024 {
        return Err(invalid());
    }
    Ok(snapshot)
}
