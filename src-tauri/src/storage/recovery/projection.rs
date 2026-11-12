use super::contracts::*;
use crate::{
    error::{AppError, AppResult},
    storage::{
        config::Config,
        layout::{Paths, CATEGORIES},
        public::contracts::{Change, Location},
    },
};
use sha2::{Digest, Sha256};
use std::path::Path;

pub(super) fn invalid() -> AppError {
    AppError::validation("storage.recovery.invalidState")
}
fn path(value: &Path) -> AppResult<String> {
    let value = value.to_str().ok_or_else(invalid)?;
    if !Path::new(value).is_absolute()
        || value.is_empty()
        || value.len() > 4096
        || value.chars().any(char::is_control)
    {
        return Err(invalid());
    }
    Ok(value.into())
}
pub(super) fn snapshot(paths: &Paths, config: &Config) -> AppResult<Snapshot> {
    let locations = CATEGORIES
        .into_iter()
        .map(|category| {
            Ok(Location {
                category,
                path: path(paths.dirs.get(&category).ok_or_else(invalid)?)?,
                default_path: path(paths.defaults.get(&category).ok_or_else(invalid)?)?,
                overridden: category == crate::storage::layout::Category::Plugins
                    && paths.plugins_override,
            })
        })
        .collect::<AppResult<Vec<_>>>()?;
    let pending = config
        .pending
        .as_ref()
        .map(|pending| {
            if uuid::Uuid::parse_str(&pending.id).is_err()
                || pending.changes.is_empty()
                || pending.changes.len() > 8
            {
                return Err(invalid());
            }
            let mut seen = std::collections::HashSet::new();
            let changes = pending
                .changes
                .iter()
                .map(|change| {
                    if !seen.insert(change.category) {
                        return Err(invalid());
                    }
                    Ok(Change {
                        category: change.category,
                        target: path(&change.target)?,
                        migrate: change.migrate,
                    })
                })
                .collect::<AppResult<Vec<_>>>()?;
            Ok(Pending {
                action: match pending.action {
                    crate::storage::config::Action::Apply => Direction::Apply,
                    crate::storage::config::Action::Cancel => Direction::Cancel,
                },
                restart_requested: pending.restart_requested,
                changes,
            })
        })
        .transpose()?;
    let mut recorded_copies = Vec::new();
    for category in CATEGORIES {
        for (kind, recorded) in [
            (CopyKind::Previous, &config.previous),
            (CopyKind::Archive, &config.archives),
        ] {
            if let Some(value) = recorded.get(&category) {
                recorded_copies.push(RecordedCopy {
                    category,
                    kind,
                    path: path(value)?,
                });
            }
        }
    }
    let mut snapshot = Snapshot {
        version: 1,
        revision: String::new(),
        locations,
        pending,
        recorded_copies,
        has_error: config.last_error.is_some(),
    };
    let mut hash = Sha256::new();
    hash.update(b"tunnelde.storage-recovery.v1\0");
    hash.update(serde_json::to_vec(config)?);
    hash.update(serde_json::to_vec(&snapshot)?);
    snapshot.revision = format!("r1:{:x}", hash.finalize());
    if serde_json::to_vec(&snapshot)?.len() > 127 * 1024 {
        return Err(invalid());
    }
    Ok(snapshot)
}
