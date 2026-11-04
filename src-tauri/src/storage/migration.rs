use std::collections::HashSet;
use std::path::{Path, PathBuf};

use super::config::{self, Change, Config, Pending};
use super::inventory;
use super::layout::{self, Category, Paths};
use crate::error::{AppError, AppResult};

const MARKER: &str = ".tunnelde-storage-migration";

pub fn validate(paths: &Paths, changes: &[Change]) -> AppResult<Vec<Change>> {
    validate_plan(paths, changes, None)
}

fn validate_plan(
    paths: &Paths,
    changes: &[Change],
    recovery: Option<&str>,
) -> AppResult<Vec<Change>> {
    if changes.is_empty() || changes.len() > 8 {
        return Err(AppError::validation("storage.invalidPlan"));
    }
    let mut categories = HashSet::new();
    let mut normalized = Vec::new();
    for change in changes {
        if !categories.insert(change.category)
            || (change.category == Category::Plugins && paths.plugins_override)
        {
            return Err(AppError::validation("storage.invalidPlan"));
        }
        let target = layout::normalize(&change.target)?;
        if target.parent().is_none() {
            return Err(AppError::validation("storage.invalidPath"));
        }
        let source = layout::normalize(paths.dir(change.category))?;
        if target == source {
            continue;
        }
        if target.starts_with(&source) || source.starts_with(&target) {
            return Err(AppError::validation("storage.pathOverlap"));
        }
        for (&other, directory) in &paths.dirs {
            // The legacy DB/cache root contains other categories, but owns only named entries.
            if matches!(other, Category::Database | Category::Cache) {
                for root in inventory::roots(other, directory) {
                    let root = layout::normalize(&root)?;
                    if target.starts_with(&root) || root.starts_with(&target) {
                        return Err(AppError::validation("storage.pathOverlap"));
                    }
                }
                continue;
            }
            let directory = layout::normalize(directory)?;
            if target.starts_with(&directory) || directory.starts_with(&target) {
                return Err(AppError::validation("storage.pathOverlap"));
            }
        }
        if !recovery.is_some_and(|id| owned(&target, id)) {
            layout::empty_target(&target)?;
        }
        normalized.push(Change {
            category: change.category,
            target,
            migrate: change.migrate,
        });
    }
    if normalized.is_empty() {
        return Err(AppError::validation("storage.invalidPlan"));
    }
    for (i, change) in normalized.iter().enumerate() {
        for other in &normalized[i + 1..] {
            if change.target.starts_with(&other.target) || other.target.starts_with(&change.target)
            {
                return Err(AppError::validation("storage.pathOverlap"));
            }
        }
    }
    // Group required bytes by destination volume, rather than checking each copy independently.
    let disks = sysinfo::Disks::new_with_refreshed_list();
    let mut required = std::collections::BTreeMap::<PathBuf, (u64, u64)>::new();
    for change in &normalized {
        if change.migrate {
            let inventory = inventory::scan(change.category, paths.dir(change.category))?;
            if recovery.is_some_and(|id| owned(&change.target, id)) {
                continue;
            }
            if let Some(disk) = disks
                .list()
                .iter()
                .filter(|disk| {
                    change.target.starts_with(disk.mount_point())
                        || layout::normalize(disk.mount_point())
                            .is_ok_and(|mount| change.target.starts_with(mount))
                })
                .max_by_key(|disk| disk.mount_point().as_os_str().len())
            {
                let entry = required
                    .entry(disk.mount_point().to_owned())
                    .or_insert((0, disk.available_space()));
                entry.0 = entry.0.saturating_add(inventory.bytes);
            }
        }
    }
    if required
        .values()
        .any(|(needed, available)| needed.saturating_add(16 * 1024 * 1024) > *available)
    {
        return Err(AppError::validation("storage.notEnoughSpace"));
    }
    Ok(normalized)
}

fn stage(change: &Change, id: &str) -> AppResult<PathBuf> {
    if uuid::Uuid::parse_str(id).is_err() {
        return Err(AppError::validation("storage.invalidPlan"));
    }
    let parent = change
        .target
        .parent()
        .ok_or_else(|| AppError::validation("storage.invalidPath"))?;
    Ok(parent.join(format!(
        ".tunnelde-migration-{id}-{}",
        change.category.name()
    )))
}

fn owned(path: &Path, id: &str) -> bool {
    std::fs::symlink_metadata(path)
        .is_ok_and(|metadata| !layout::linked(&metadata) && metadata.is_dir())
        && std::fs::symlink_metadata(path.join(MARKER)).is_ok_and(|metadata| {
            !layout::linked(&metadata) && metadata.is_file() && metadata.len() == id.len() as u64
        })
        && std::fs::read_to_string(path.join(MARKER)).is_ok_and(|value| value == id)
}

fn entries(
    path: &Path,
    marker: bool,
) -> AppResult<std::collections::BTreeMap<std::ffi::OsString, PathBuf>> {
    let mut result = std::collections::BTreeMap::new();
    for entry in std::fs::read_dir(path)? {
        let entry = entry?;
        if marker && entry.file_name() == MARKER {
            continue;
        }
        if result.len() >= 200_000 {
            return Err(AppError::validation("storage.tooManyFiles"));
        }
        result.insert(entry.file_name(), entry.path());
    }
    Ok(result)
}

fn equal_tree(from: &Path, to: &Path, depth: usize, count: &mut usize) -> AppResult<bool> {
    *count += 1;
    if depth > 64 || *count > 200_000 {
        return Err(AppError::validation("storage.tooManyFiles"));
    }
    let a = std::fs::symlink_metadata(from)?;
    let Some(b) = layout::metadata(to)? else {
        return Ok(false);
    };
    if layout::linked(&a) || layout::linked(&b) {
        return Ok(false);
    }
    if a.is_file() && b.is_file() {
        return Ok(a.len() == b.len() && inventory::digest(from)? == inventory::digest(to)?);
    }
    if !a.is_dir() || !b.is_dir() {
        return Ok(false);
    }
    let source = entries(from, false)?;
    let target = entries(to, false)?;
    if source.keys().ne(target.keys()) {
        return Ok(false);
    }
    for (name, path) in source {
        if !equal_tree(&path, &target[&name], depth + 1, count)? {
            return Ok(false);
        }
    }
    Ok(true)
}

/// A crash can leave published directories before the configuration is committed. Reuse them
/// only if every entry still matches the original; a modified target is never overwritten.
fn verify_published(paths: &Paths, change: &Change) -> AppResult<()> {
    let target = entries(&change.target, true)?;
    let mut source = std::collections::BTreeMap::new();
    if change.migrate {
        for root in inventory::roots(change.category, paths.dir(change.category)) {
            if layout::metadata(&root)?.is_none() {
                continue;
            }
            if matches!(change.category, Category::Database | Category::Cache) {
                source.insert(root.file_name().unwrap().to_owned(), root);
            } else {
                source.extend(entries(&root, true)?);
            }
        }
    }
    let mut count = 0;
    if source.keys().ne(target.keys()) {
        return Err(AppError::validation("storage.verificationFailed"));
    }
    for (name, path) in source {
        if !equal_tree(&path, &target[&name], 0, &mut count)? {
            return Err(AppError::validation("storage.verificationFailed"));
        }
    }
    Ok(())
}

fn copy_category(paths: &Paths, change: &Change, staging: &Path) -> AppResult<()> {
    if !change.migrate {
        return Ok(());
    }
    let source = paths.dir(change.category);
    for root in inventory::roots(change.category, source) {
        if layout::metadata(&root)?.is_none() {
            continue;
        }
        if matches!(change.category, Category::Database | Category::Cache) {
            inventory::copy_verified(&root, &staging.join(root.file_name().unwrap()), 0)?;
        } else {
            if layout::linked(&std::fs::symlink_metadata(&root)?) {
                return Err(AppError::validation("storage.linkUnsupported"));
            }
            for entry in std::fs::read_dir(&root)? {
                let entry = entry?;
                if entry.file_name() == MARKER {
                    continue;
                }
                inventory::copy_verified(&entry.path(), &staging.join(entry.file_name()), 0)?;
            }
        }
    }
    Ok(())
}

/// Runs before SQLite, log writers, plugin processes or sessions open any source data.
/// Originals remain as a recovery copy. The pointer switches only after all copies verify.
pub fn apply(paths: &Paths, config: &mut Config) -> AppResult<()> {
    let Some(pending) = config.pending.clone() else {
        return Ok(());
    };
    if uuid::Uuid::parse_str(&pending.id).is_err() {
        return Err(AppError::validation("storage.invalidPlan"));
    }
    let changes = validate_plan(paths, &pending.changes, Some(&pending.id))?;
    let mut staging = Vec::new();
    let prepared = (|| {
        for change in &changes {
            if owned(&change.target, &pending.id) {
                verify_published(paths, change)?;
                staging.push(None);
                continue;
            }
            let destination = stage(change, &pending.id)?;
            if destination.try_exists()? {
                if !owned(&destination, &pending.id) {
                    return Err(AppError::validation("storage.targetNotEmpty"));
                }
                std::fs::remove_dir_all(&destination)?;
            }
            std::fs::create_dir_all(destination.parent().unwrap())?;
            std::fs::create_dir(&destination)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&destination, std::fs::Permissions::from_mode(0o700))?;
            }
            std::fs::write(destination.join(MARKER), &pending.id)?;
            staging.push(Some(destination.clone()));
            copy_category(paths, change, &destination)?;
        }
        for (change, stage) in changes.iter().zip(&staging) {
            let Some(stage) = stage else {
                continue;
            };
            // Recheck directly before publication, including a directory changed during copying.
            layout::empty_target(&change.target)?;
            if change.target.exists() {
                std::fs::remove_dir(&change.target)?;
            }
            std::fs::rename(stage, &change.target)?;
        }
        let mut next = config.clone();
        for change in &changes {
            next.previous
                .insert(change.category, paths.dir(change.category).to_owned());
            next.locations
                .insert(change.category, change.target.clone());
        }
        next.pending = None;
        next.last_error = None;
        config::save(&paths.home, &next)?;
        *config = next;
        for change in &changes {
            if owned(&change.target, &pending.id) {
                let _ = std::fs::remove_file(change.target.join(MARKER));
            }
        }
        Ok::<_, AppError>(())
    })();
    // Only remove our reserved staging directories, never source or published destination data.
    for directory in staging.into_iter().flatten() {
        if owned(&directory, &pending.id) {
            let _ = std::fs::remove_dir_all(directory);
        }
    }
    prepared
}

pub fn schedule(paths: &Paths, config: &mut Config, changes: Vec<Change>) -> AppResult<()> {
    if config.pending.is_some() {
        return Err(AppError::validation("storage.planPending"));
    }
    let changes = validate(paths, &changes)?;
    config.pending = Some(Pending {
        id: uuid::Uuid::new_v4().to_string(),
        changes,
    });
    config.last_error = None;
    config::save(&paths.home, config)
}
