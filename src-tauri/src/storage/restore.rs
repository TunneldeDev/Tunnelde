use std::path::{Component, Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::config::Change;
use super::inventory;
use super::layout::{self, Category, Paths};
use super::migration::{equal_tree, owned, stage, MARKER};
use crate::error::{AppError, AppResult};

const JOURNAL: &str = "restore.json";

#[derive(Serialize, Deserialize)]
struct Journal {
    category: Category,
    target: PathBuf,
    source: PathBuf,
    originals: Vec<PathBuf>,
    installed: Vec<PathBuf>,
}

pub(super) fn is_default(paths: &Paths, change: &Change) -> AppResult<bool> {
    Ok(layout::normalize(&change.target)? == layout::normalize(&paths.defaults[&change.category])?)
}

pub(super) fn backup_root(category: Category, target: &Path) -> AppResult<PathBuf> {
    let parent = if matches!(category, Category::Database | Category::Cache) {
        target
    } else {
        target
            .parent()
            .ok_or_else(|| AppError::validation("storage.invalidPath"))?
    };
    Ok(parent.join("storage-recovery").join(category.name()))
}

fn archive(change: &Change, id: &str) -> AppResult<PathBuf> {
    if uuid::Uuid::parse_str(id).is_err() {
        return Err(AppError::validation("storage.invalidPlan"));
    }
    Ok(backup_root(change.category, &change.target)?.join(id))
}

fn name(path: &Path) -> AppResult<PathBuf> {
    let value = path
        .file_name()
        .ok_or_else(|| AppError::validation("storage.invalidPath"))?;
    Ok(PathBuf::from(value))
}

fn names(category: Category, path: &Path) -> AppResult<Vec<PathBuf>> {
    let mut result = Vec::new();
    if matches!(category, Category::Database | Category::Cache) {
        for root in inventory::roots(category, path) {
            if layout::metadata(&root)?.is_some() {
                result.push(name(&root)?);
            }
        }
    } else if layout::metadata(path)?.is_some() {
        for entry in std::fs::read_dir(path)? {
            let entry = entry?;
            if entry.file_name() != MARKER {
                result.push(name(&entry.path())?);
            }
            if result.len() > 200_000 {
                return Err(AppError::validation("storage.tooManyFiles"));
            }
        }
    }
    result.sort();
    Ok(result)
}

fn load(paths: &Paths, change: &Change, id: &str) -> AppResult<Journal> {
    use std::io::Read;
    let directory = archive(change, id)?;
    if !owned(&directory, id) {
        return Err(AppError::validation("storage.verificationFailed"));
    }
    let original = std::fs::symlink_metadata(directory.join("original"))?;
    if !original.is_dir() || layout::linked(&original) {
        return Err(AppError::validation("storage.verificationFailed"));
    }
    let journal_path = directory.join(JOURNAL);
    let metadata = std::fs::symlink_metadata(&journal_path)?;
    if !metadata.is_file() || layout::linked(&metadata) {
        return Err(AppError::validation("storage.verificationFailed"));
    }
    let mut bytes = Vec::new();
    std::fs::File::open(journal_path)?
        .take(4 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)?;
    let journal: Journal = serde_json::from_slice(&bytes)
        .map_err(|_| AppError::validation("storage.verificationFailed"))?;
    if bytes.len() > 4 * 1024 * 1024
        || journal.category != change.category
        || journal.target != change.target
        || journal.source != paths.dir(change.category)
    {
        return Err(AppError::validation("storage.verificationFailed"));
    }
    for entries in [&journal.originals, &journal.installed] {
        let mut unique = std::collections::HashSet::new();
        for entry in entries {
            let mut components = entry.components();
            if !matches!(components.next(), Some(Component::Normal(_)))
                || components.next().is_some()
                || entry == Path::new(MARKER)
                || !unique.insert(entry)
            {
                return Err(AppError::validation("storage.verificationFailed"));
            }
            if matches!(change.category, Category::Database | Category::Cache)
                && !inventory::roots(change.category, Path::new(""))
                    .iter()
                    .any(|root| root == entry)
            {
                return Err(AppError::validation("storage.verificationFailed"));
            }
        }
    }
    Ok(journal)
}

pub(super) fn pending(change: &Change, id: &str) -> AppResult<bool> {
    Ok(layout::metadata(&archive(change, id)?)?.is_some())
}

fn verify_installed(paths: &Paths, change: &Change, entry: &Path) -> AppResult<()> {
    if !change.migrate
        || !equal_tree(
            &paths.dir(change.category).join(entry),
            &change.target.join(entry),
            0,
            &mut 0,
        )?
    {
        return Err(AppError::validation("storage.verificationFailed"));
    }
    Ok(())
}

/// Preserve previous default data per category; never rename the shared application root.
/// The journal is written before any rename, so a restart can continue each individual entry.
pub(super) fn publish(
    paths: &Paths,
    change: &Change,
    id: &str,
    staging: &Path,
) -> AppResult<PathBuf> {
    let directory = archive(change, id)?;
    if !pending(change, id)? {
        inventory::scan(change.category, &change.target)?;
        let journal = Journal {
            category: change.category,
            target: change.target.clone(),
            source: paths.dir(change.category).to_owned(),
            originals: names(change.category, &change.target)?,
            installed: names(change.category, staging)?,
        };
        let bytes = serde_json::to_vec(&journal)?;
        if bytes.len() > 4 * 1024 * 1024 {
            return Err(AppError::validation("storage.tooManyFiles"));
        }
        std::fs::create_dir_all(directory.parent().unwrap())?;
        let preparing = directory.with_extension("preparing");
        if layout::metadata(&preparing)?.is_some() {
            if !owned(&preparing, id) {
                return Err(AppError::validation("storage.targetNotEmpty"));
            }
            std::fs::remove_dir_all(&preparing)?;
        }
        std::fs::create_dir(&preparing)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&preparing, std::fs::Permissions::from_mode(0o700))?;
        }
        std::fs::write(preparing.join(MARKER), id)?;
        std::fs::create_dir(preparing.join("original"))?;
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(preparing.join(JOURNAL))?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        drop(file);
        std::fs::rename(preparing, &directory)?;
    }
    let journal = load(paths, change, id)?;
    std::fs::create_dir_all(&change.target)?;
    for entry in &journal.originals {
        let saved = directory.join("original").join(entry);
        if layout::metadata(&saved)?.is_none() {
            let original = change.target.join(entry);
            let metadata = std::fs::symlink_metadata(&original)?;
            if layout::linked(&metadata) {
                return Err(AppError::validation("storage.linkUnsupported"));
            }
            std::fs::rename(original, saved)?;
        }
    }
    for entry in &journal.installed {
        let staged = staging.join(entry);
        let destination = change.target.join(entry);
        if layout::metadata(&staged)?.is_some() {
            if layout::metadata(&destination)?.is_some() {
                return Err(AppError::validation("storage.targetNotEmpty"));
            }
            std::fs::rename(staged, destination)?;
        }
        verify_installed(paths, change, entry)?;
    }
    if names(change.category, &change.target)? != journal.installed {
        return Err(AppError::validation("storage.verificationFailed"));
    }
    Ok(directory.join("original"))
}

/// Cancellation restores archived defaults only after checking that published entries
/// still match the migration source. Modified files are retained and reported, never deleted.
pub(super) fn cancel(paths: &Paths, change: &Change, id: &str) -> AppResult<()> {
    if !pending(change, id)? {
        return Ok(());
    }
    let journal = load(paths, change, id)?;
    let staging = stage(change, id)?;
    if !owned(&staging, id) {
        return Err(AppError::validation("storage.verificationFailed"));
    }
    let directory = archive(change, id)?;
    for entry in &journal.installed {
        if layout::metadata(&staging.join(entry))?.is_none() {
            verify_installed(paths, change, entry)?;
        }
    }
    for entry in &journal.installed {
        if layout::metadata(&staging.join(entry))?.is_none() {
            std::fs::rename(change.target.join(entry), staging.join(entry))?;
        }
    }
    for entry in &journal.originals {
        let saved = directory.join("original").join(entry);
        if layout::metadata(&saved)?.is_some() {
            if layout::metadata(&change.target.join(entry))?.is_some() {
                return Err(AppError::validation("storage.targetNotEmpty"));
            }
            std::fs::rename(saved, change.target.join(entry))?;
        }
    }
    std::fs::remove_dir_all(directory)?;
    std::fs::remove_dir_all(staging)?;
    Ok(())
}
