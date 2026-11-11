//! Hash and capture the same bytes: an approved package cannot change between
//! fingerprint validation and serving executable frontend assets.
use std::collections::{BTreeMap, BTreeSet};
use std::io::Read;
use std::path::Path;
use std::sync::Arc;

use sha2::{Digest, Sha256};

use crate::error::{AppError, AppResult};

const MAX_FRONTEND_BYTES: usize = 8 * 1024 * 1024;

pub(crate) struct PackageSnapshot {
    pub digest: String,
    pub assets: BTreeMap<String, Arc<[u8]>>,
    pub bytes: usize,
    pub directories: BTreeSet<String>,
}
pub(crate) type FrontendSnapshot = PackageSnapshot;

struct Capture<'a> {
    prefix: &'a str,
    assets: BTreeMap<String, Arc<[u8]>>,
    bytes: usize,
    limit: usize,
    limit_error: &'static str,
    directories: BTreeSet<String>,
}

fn visit(
    root: &Path,
    directory: &Path,
    hasher: &mut Sha256,
    files: &mut usize,
    bytes: &mut u64,
    depth: usize,
    capture: &mut Option<Capture<'_>>,
) -> AppResult<()> {
    if depth > 32 {
        return Err(AppError::validation("pluginSecurity.packageInvalid"));
    }
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(directory)? {
        if entries.len() >= 2000usize.saturating_sub(*files) {
            return Err(AppError::validation("pluginSecurity.packageInvalid"));
        }
        entries.push(entry?);
    }
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        *files += 1;
        if *files > 2000 {
            return Err(AppError::validation("pluginSecurity.packageInvalid"));
        }
        let kind = entry.file_type()?;
        let path = entry.path();
        let relative = path
            .strip_prefix(root)
            .map_err(|_| AppError::validation("pluginSecurity.packageInvalid"))?;
        let name = relative
            .to_str()
            .ok_or_else(|| AppError::validation("pluginSecurity.packageInvalid"))?
            .replace('\\', "/");
        hasher.update((name.len() as u64).to_le_bytes());
        hasher.update(name.as_bytes());
        if kind.is_dir() {
            hasher.update(b"directory");
            if let Some(c) = capture.as_mut().filter(|c| name.starts_with(c.prefix)) {
                c.directories.insert(name[c.prefix.len()..].into());
            }
            visit(root, &path, hasher, files, bytes, depth + 1, capture)?;
        } else if kind.is_file() {
            hasher.update(b"file");
            let mut file = std::fs::File::open(path)?;
            let size = file.metadata()?.len();
            hasher.update(size.to_le_bytes());
            let retain = capture.as_ref().is_some_and(|c| name.starts_with(c.prefix));
            let mut content = Vec::new();
            let mut buffer = [0_u8; 64 * 1024];
            loop {
                let read = file.read(&mut buffer)?;
                if read == 0 {
                    break;
                }
                *bytes += read as u64;
                if *bytes > 64 * 1024 * 1024 {
                    return Err(AppError::validation("pluginSecurity.packageInvalid"));
                }
                hasher.update(&buffer[..read]);
                if retain {
                    let c = capture.as_mut().expect("capture selected");
                    c.bytes += read;
                    if c.bytes > c.limit {
                        return Err(AppError::validation(c.limit_error));
                    }
                    content.extend_from_slice(&buffer[..read]);
                }
            }
            if retain {
                let c = capture.as_mut().expect("capture selected");
                if c.assets
                    .insert(name[c.prefix.len()..].into(), content.into())
                    .is_some()
                {
                    return Err(AppError::validation("pluginSecurity.packageInvalid"));
                }
            }
        } else {
            return Err(AppError::validation("pluginSecurity.packageInvalid"));
        }
    }
    Ok(())
}

fn read(root: &Path, capture: &mut Option<Capture<'_>>) -> AppResult<String> {
    if std::fs::symlink_metadata(root)?.file_type().is_symlink() {
        return Err(AppError::validation("pluginSecurity.packageInvalid"));
    }
    let mut hasher = Sha256::new();
    visit(root, root, &mut hasher, &mut 0, &mut 0, 0, capture)?;
    Ok(format!("{:x}", hasher.finalize()))
}

pub(super) fn fingerprint(root: &Path) -> AppResult<String> {
    read(root, &mut None)
}

pub(crate) fn frontend_snapshot(root: &Path, prefix: &str) -> AppResult<FrontendSnapshot> {
    snapshot(
        root,
        prefix,
        MAX_FRONTEND_BYTES,
        "plugin.frontend.assetsTooLarge",
    )
}

pub(crate) fn deployment_snapshot(root: &Path) -> AppResult<PackageSnapshot> {
    snapshot(root, "", 32 * 1024 * 1024, "plugin.runners.packageTooLarge")
}

fn snapshot(
    root: &Path,
    prefix: &str,
    limit: usize,
    limit_error: &'static str,
) -> AppResult<PackageSnapshot> {
    let mut capture = Some(Capture {
        prefix,
        assets: BTreeMap::new(),
        bytes: 0,
        limit,
        limit_error,
        directories: BTreeSet::new(),
    });
    let digest = read(root, &mut capture)?;
    let capture = capture.expect("capture provided");
    Ok(PackageSnapshot {
        digest,
        assets: capture.assets,
        bytes: capture.bytes,
        directories: capture.directories,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn captured_assets_match_the_approved_digest_and_do_not_follow_later_edits() {
        let root =
            std::env::temp_dir().join(format!("tunnelde-ui-snapshot-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("ui/nested")).unwrap();
        std::fs::write(root.join("ui/index.mjs"), "export const value=1").unwrap();
        std::fs::write(root.join("ui/nested/asset.txt"), "asset").unwrap();
        std::fs::write(root.join("backend.mjs"), "backend").unwrap();
        let expected = fingerprint(&root).unwrap();
        let snapshot = frontend_snapshot(&root, "ui/").unwrap();
        assert_eq!(snapshot.digest, expected);
        assert_eq!(snapshot.assets.len(), 2);
        assert_eq!(snapshot.assets["nested/asset.txt"].as_ref(), b"asset");
        std::fs::write(root.join("ui/index.mjs"), "export const value=2").unwrap();
        assert_ne!(fingerprint(&root).unwrap(), snapshot.digest);
        assert_eq!(
            snapshot.assets["index.mjs"].as_ref(),
            b"export const value=1"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn frontend_capture_limits_are_independent_of_package_fingerprint_limits() {
        let root = std::env::temp_dir().join(format!("tunnelde-ui-size-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("ui")).unwrap();
        std::fs::write(root.join("ui/asset.bin"), vec![0; MAX_FRONTEND_BYTES + 1]).unwrap();
        assert!(fingerprint(&root).is_ok());
        assert_eq!(
            frontend_snapshot(&root, "ui/").err().unwrap().to_string(),
            "plugin.frontend.assetsTooLarge"
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
