//! Snapshot the approved package before any remote mutation; never reread uploads.
use crate::{
    error::{AppError, AppResult},
    plugins::security::PackageSnapshot,
};
use std::{collections::BTreeSet, path::Path};

pub(super) struct Package {
    pub directories: BTreeSet<String>,
    pub files: Vec<(String, std::sync::Arc<[u8]>)>,
}

impl Package {
    pub(super) fn capture(root: &Path, fingerprint: &str, platform: &str) -> AppResult<Self> {
        Self::from_snapshot(
            crate::plugins::security::deployment_snapshot(root)?,
            fingerprint,
            platform,
        )
    }

    fn from_snapshot(
        snapshot: PackageSnapshot,
        fingerprint: &str,
        platform: &str,
    ) -> AppResult<Self> {
        if snapshot.digest != fingerprint {
            return Err(AppError::validation("pluginSecurity.changed"));
        }
        let helper = if platform == "windows" {
            "tunnelde-agent.exe"
        } else {
            "tunnelde-agent"
        };
        let include = |name: &str| {
            !name
                .split('/')
                .any(|part| part.starts_with('.') || matches!(part, "node_modules" | "tests"))
        };
        let mut directories: BTreeSet<_> = snapshot
            .directories
            .into_iter()
            .filter(|name| include(name))
            .collect();
        for name in &directories {
            let root = name.split('/').next().unwrap_or_default();
            if root == helper || (platform == "windows" && root.eq_ignore_ascii_case(helper)) {
                return Err(AppError::validation("plugin.runners.helperCollision"));
            }
        }
        let mut files = Vec::new();
        for (name, bytes) in snapshot.assets {
            if name
                .split('/')
                .any(|part| part.starts_with('.') || matches!(part, "node_modules" | "tests"))
            {
                continue;
            }
            let root = name.split('/').next().unwrap_or_default();
            if root == helper || (platform == "windows" && root.eq_ignore_ascii_case(helper)) {
                return Err(AppError::validation("plugin.runners.helperCollision"));
            }
            let mut parent = name.as_str();
            while let Some((prefix, _)) = parent.rsplit_once('/') {
                directories.insert(prefix.to_owned());
                parent = prefix;
            }
            files.push((name, bytes));
        }
        Ok(Self { directories, files })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn approved_bytes_are_retained_and_helper_names_cannot_be_overwritten() {
        let root =
            std::env::temp_dir().join(format!("tunnelde-deploy-package-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("ui/nested")).unwrap();
        std::fs::create_dir_all(root.join("empty")).unwrap();
        std::fs::write(root.join("ui/nested/entry.mjs"), b"approved").unwrap();
        let fingerprint = crate::plugins::security::fingerprint(&root).unwrap();
        let package = Package::capture(&root, &fingerprint, "windows").unwrap();
        std::fs::write(root.join("ui/nested/entry.mjs"), b"replaced").unwrap();
        assert_eq!(package.files[0].1.as_ref(), b"approved");
        assert_eq!(
            package.directories.into_iter().collect::<Vec<_>>(),
            ["empty", "ui", "ui/nested"]
        );
        assert!(Package::capture(&root, &fingerprint, "windows").is_err());
        std::fs::write(root.join("TUNNELDE-AGENT.EXE"), b"overwrite").unwrap();
        let fingerprint = crate::plugins::security::fingerprint(&root).unwrap();
        assert!(Package::capture(&root, &fingerprint, "windows").is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
}
