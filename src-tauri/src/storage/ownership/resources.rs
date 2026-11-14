//! Coordinate cooperating data homes without putting lock files in migrated data.
//! Allocation is serialized; each immutable claim is held by an OS file lease.
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use super::Lease;
use crate::error::{AppError, AppResult};
use crate::storage::{config::Config, layout, migration, restore};

#[cfg(target_os = "macos")]
mod macos;

const MAX_CLAIMS: usize = 4096;
const MAX_RECORD_BYTES: u64 = 128 * 1024;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    version: u32,
    roots: Vec<PathBuf>,
}

pub(super) struct Claim {
    // Do not unlink on drop: an allocator may already be inspecting this inode.
    // A later allocator reclaims inactive records while holding the registry lock.
    _lease: Lease,
    path: PathBuf,
}

pub(super) fn pending_roots(paths: &layout::Paths, config: &Config) -> AppResult<Vec<PathBuf>> {
    let mut roots = Vec::new();
    if let Some(pending) = &config.pending {
        if uuid::Uuid::parse_str(&pending.id).is_err()
            || pending.changes.is_empty()
            || pending.changes.len() > 8
        {
            return Err(AppError::validation("storage.invalidPlan"));
        }
        for change in &pending.changes {
            let target = layout::normalize(&change.target)?;
            if target.parent().is_none() {
                return Err(AppError::validation("storage.invalidPath"));
            }
            roots.push(target);
            roots.push(layout::normalize(&migration::stage(change, &pending.id)?)?);
            if restore::is_default(paths, change)? {
                roots.push(layout::normalize(&restore::backup_root(
                    change.category,
                    &change.target,
                )?)?);
            }
        }
    }
    Ok(roots)
}

impl Claim {
    pub(super) fn home(path: &Path) -> AppResult<Self> {
        Self::system(&[path.to_owned()], None)
    }

    pub(super) fn acquire(
        paths: &layout::Paths,
        extra: &[PathBuf],
        own: Option<&Self>,
    ) -> AppResult<Self> {
        let mut roots: Vec<_> = paths.dirs.values().cloned().collect();
        roots.push(paths.home.clone());
        roots.extend_from_slice(extra);
        Self::system(&roots, own)
    }

    fn system(roots: &[PathBuf], own: Option<&Self>) -> AppResult<Self> {
        #[cfg(unix)]
        let namespace = format!(
            "tunnelde-storage-ownership-v1-{}",
            rustix::process::geteuid().as_raw()
        );
        #[cfg(not(unix))]
        let namespace = "tunnelde-storage-ownership-v1";
        let registry = std::env::temp_dir().join(namespace);
        Self::reserve(&registry, roots, own).map_err(|error| {
            if error.kind() == io::ErrorKind::WouldBlock {
                AppError::internal("Another Tunnelde process is using an overlapping storage location. Quit it before starting this instance.")
            } else {
                AppError::internal(format!("Cannot acquire storage location ownership: {error}"))
            }
        })
    }

    #[cfg(test)]
    fn in_registry(registry: &Path, roots: &[PathBuf]) -> io::Result<Self> {
        Self::reserve(registry, roots, None)
    }

    fn reserve(registry: &Path, roots: &[PathBuf], own: Option<&Self>) -> io::Result<Self> {
        create_registry(registry)?;
        let registry = normalize(registry)?;
        let mut roots: Vec<_> = roots
            .iter()
            .map(|root| normalize(root))
            .collect::<io::Result<_>>()?;
        roots.sort();
        roots.dedup();
        if roots.is_empty() || roots.len() > 64 || roots.iter().any(|root| overlap(root, &registry))
        {
            return Err(invalid("Storage locations overlap the ownership registry"));
        }
        let deadline = Instant::now() + Duration::from_secs(2);
        let _allocator = loop {
            match Lease::acquire(&registry) {
                Ok(lease) => break lease,
                Err(error)
                    if error.kind() == io::ErrorKind::WouldBlock && Instant::now() < deadline =>
                {
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(error) => return Err(error),
            }
        };
        let mut count = 0;
        for entry in std::fs::read_dir(&registry)? {
            let entry = entry?;
            let path = entry.path();
            if own.is_some_and(|claim| claim.path == path) {
                continue;
            }
            if path.extension().is_none_or(|ext| ext != "json")
                || path
                    .file_stem()
                    .and_then(|name| name.to_str())
                    .is_none_or(|name| uuid::Uuid::parse_str(name).is_err())
            {
                continue;
            }
            count += 1;
            if count > MAX_CLAIMS {
                return Err(invalid("Storage ownership registry is too large"));
            }
            match Lease::open(&path, false) {
                Ok(inactive) => {
                    // Every allocator uses the same lock, so no new owner can
                    // claim this name between dropping its handle and unlinking.
                    drop(inactive);
                    std::fs::remove_file(path)?;
                }
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                    let mut bytes = Vec::new();
                    std::fs::File::open(&path)?
                        .take(MAX_RECORD_BYTES + 1)
                        .read_to_end(&mut bytes)?;
                    let record: Record = serde_json::from_slice(&bytes)
                        .map_err(|_| invalid("Invalid active storage ownership record"))?;
                    if bytes.len() as u64 > MAX_RECORD_BYTES
                        || record.version != 1
                        || record.roots.is_empty()
                        || record.roots.len() > 64
                        || record.roots.iter().any(|path| !path.is_absolute())
                    {
                        return Err(invalid("Invalid active storage ownership record"));
                    }
                    if roots
                        .iter()
                        .any(|root| record.roots.iter().any(|other| overlap(root, other)))
                    {
                        return Err(io::Error::new(
                            io::ErrorKind::WouldBlock,
                            "Storage location is already in use",
                        ));
                    }
                }
                Err(error) => return Err(error),
            }
        }
        let record = serde_json::to_vec(&Record { version: 1, roots }).map_err(io::Error::other)?;
        if record.len() as u64 > MAX_RECORD_BYTES {
            return Err(invalid("Storage ownership record is too large"));
        }
        let path = registry.join(format!("{}.json", uuid::Uuid::new_v4()));
        let lease = Lease::open(&path, true)?;
        let mut file = &lease._file;
        file.write_all(&record)?;
        file.sync_all()?;
        Ok(Self {
            _lease: lease,
            path,
        })
    }
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

fn create_registry(path: &Path) -> io::Result<()> {
    let builder = std::fs::DirBuilder::new();
    #[cfg(unix)]
    let builder = {
        use std::os::unix::fs::DirBuilderExt;
        let mut builder = builder;
        builder.mode(0o700);
        builder
    };
    match builder.create(path) {
        Ok(()) => (),
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => (),
        Err(error) => return Err(error),
    }
    let metadata = std::fs::symlink_metadata(path)?;
    if !metadata.is_dir() || layout::linked(&metadata) {
        return Err(invalid("Invalid storage ownership registry"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        // Linux's temporary parent may be shared by multiple login accounts.
        if metadata.uid() != rustix::process::geteuid().as_raw() || metadata.mode() & 0o077 != 0 {
            return Err(invalid(
                "Storage ownership registry must be private to the current user",
            ));
        }
    }
    Ok(())
}

fn normalize(path: &Path) -> io::Result<PathBuf> {
    let path = layout::normalize(path).map_err(io::Error::other)?;
    #[cfg(windows)]
    let path = PathBuf::from(path.to_string_lossy().to_lowercase());
    #[cfg(target_os = "macos")]
    let path = macos::normalize_case(&path)?;
    Ok(path)
}

fn overlap(first: &Path, second: &Path) -> bool {
    first.starts_with(second) || second.starts_with(first)
}

#[cfg(test)]
mod tests;
