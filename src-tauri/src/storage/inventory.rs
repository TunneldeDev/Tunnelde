use std::path::{Path, PathBuf};

use serde::Serialize;
use sha2::{Digest, Sha256};

use super::layout::{linked, metadata, Category};
use crate::error::{AppError, AppResult};

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Inventory {
    pub bytes: u64,
    pub files: u64,
}

pub fn roots(category: Category, directory: &Path) -> Vec<PathBuf> {
    match category {
        Category::Database => [
            "tunnelde.db",
            "tunnelde.db-wal",
            "tunnelde.db-shm",
            "native-file-saves",
        ]
        .into_iter()
        .map(|name| directory.join(name))
        .collect(),
        Category::Cache => ["marketplace", "tmp"]
            .into_iter()
            .map(|name| directory.join(name))
            .collect(),
        _ => vec![directory.to_path_buf()],
    }
}

pub fn scan(category: Category, directory: &Path) -> AppResult<Inventory> {
    let mut result = Inventory { bytes: 0, files: 0 };
    let mut entries = 0;
    for root in roots(category, directory) {
        if metadata(&root)?.is_some() {
            walk(&root, &mut result, 0, &mut entries)?;
        }
    }
    Ok(result)
}

fn walk(
    path: &Path,
    inventory: &mut Inventory,
    depth: usize,
    entries: &mut usize,
) -> AppResult<()> {
    let metadata = std::fs::symlink_metadata(path)?;
    if linked(&metadata) {
        return Err(AppError::validation("storage.linkUnsupported"));
    }
    *entries += 1;
    if depth > 64 || *entries > 200_000 {
        return Err(AppError::validation("storage.tooManyFiles"));
    }
    if metadata.is_dir() {
        for entry in std::fs::read_dir(path)? {
            walk(&entry?.path(), inventory, depth + 1, entries)?;
        }
    } else if metadata.is_file() {
        inventory.files += 1;
        inventory.bytes = inventory
            .bytes
            .checked_add(metadata.len())
            .ok_or_else(|| AppError::validation("storage.tooManyFiles"))?;
    } else {
        return Err(AppError::validation("storage.linkUnsupported"));
    }
    Ok(())
}

pub fn digest(path: &Path) -> AppResult<[u8; 32]> {
    use std::io::Read;
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0; 64 * 1024];
    loop {
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        hasher.update(&buffer[..n]);
    }
    Ok(hasher.finalize().into())
}

pub fn copy_verified(from: &Path, to: &Path, depth: usize) -> AppResult<()> {
    copy_entry(from, to, depth, &mut 0)
}

fn copy_entry(from: &Path, to: &Path, depth: usize, entries: &mut usize) -> AppResult<()> {
    let metadata = std::fs::symlink_metadata(from)?;
    *entries += 1;
    if *entries > 200_000 {
        return Err(AppError::validation("storage.tooManyFiles"));
    }
    if linked(&metadata) || depth > 64 {
        return Err(AppError::validation("storage.linkUnsupported"));
    }
    if metadata.is_dir() {
        std::fs::create_dir(to)?;
        for entry in std::fs::read_dir(from)? {
            let entry = entry?;
            copy_entry(
                &entry.path(),
                &to.join(entry.file_name()),
                depth + 1,
                entries,
            )?;
        }
        std::fs::set_permissions(to, metadata.permissions())?;
    } else if metadata.is_file() {
        use std::io::Write;
        let mut source = std::fs::File::open(from)?;
        let mut target = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(to)?;
        std::io::copy(&mut source, &mut target)?;
        target.flush()?;
        target.sync_all()?;
        std::fs::set_permissions(to, metadata.permissions())?;
        if digest(from)? != digest(to)? || std::fs::metadata(from)?.len() != metadata.len() {
            return Err(AppError::validation("storage.verificationFailed"));
        }
    } else {
        return Err(AppError::validation("storage.linkUnsupported"));
    }
    Ok(())
}
