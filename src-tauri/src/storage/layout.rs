use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Copy, Hash, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Category {
    Database,
    Plugins,
    PluginData,
    Keys,
    Runtimes,
    Cache,
    Logs,
    Runners,
}

pub const CATEGORIES: [Category; 8] = [
    Category::Database,
    Category::Plugins,
    Category::PluginData,
    Category::Keys,
    Category::Runtimes,
    Category::Cache,
    Category::Logs,
    Category::Runners,
];

impl Category {
    pub fn name(self) -> &'static str {
        match self {
            Self::Database => "database",
            Self::Plugins => "plugins",
            Self::PluginData => "plugin-data",
            Self::Keys => "keys",
            Self::Runtimes => "runtimes",
            Self::Cache => "cache",
            Self::Logs => "logs",
            Self::Runners => "runners",
        }
    }
}

#[derive(Clone)]
pub struct Paths {
    pub home: PathBuf,
    pub dirs: BTreeMap<Category, PathBuf>,
    pub defaults: BTreeMap<Category, PathBuf>,
    pub plugins_override: bool,
}

impl Paths {
    pub fn new(
        home: PathBuf,
        logs: PathBuf,
        overrides: &BTreeMap<Category, PathBuf>,
        plugins: Option<PathBuf>,
    ) -> Self {
        let defaults = BTreeMap::from([
            (Category::Database, home.clone()),
            (Category::Cache, home.clone()),
            (Category::Plugins, home.join("plugins")),
            (Category::PluginData, home.join("plugin-data")),
            (Category::Keys, home.join("keys")),
            (Category::Runtimes, home.join("runtimes")),
            (Category::Logs, logs),
            (Category::Runners, home.join("plugin-runners")),
        ]);
        let mut dirs = defaults.clone();
        dirs.extend(overrides.clone());
        let plugins_override = plugins.is_some();
        if let Some(plugins) = plugins {
            dirs.insert(Category::Plugins, plugins);
        }
        Self {
            home,
            dirs,
            defaults,
            plugins_override,
        }
    }
    pub fn dir(&self, category: Category) -> &Path {
        &self.dirs[&category]
    }
}

pub fn normalize(path: &Path) -> AppResult<PathBuf> {
    use std::path::Component;
    if !path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, Component::ParentDir))
    {
        return Err(AppError::validation("storage.invalidPath"));
    }
    let mut missing = Vec::new();
    let mut parent = path;
    // Reject the selected junction itself; canonicalize parent aliases such as macOS /var.
    if metadata(path)?.is_some_and(|metadata| linked(&metadata)) {
        return Err(AppError::validation("storage.linkUnsupported"));
    }
    while !parent.try_exists()? {
        missing.push(
            parent
                .file_name()
                .ok_or_else(|| AppError::validation("storage.invalidPath"))?,
        );
        parent = parent
            .parent()
            .ok_or_else(|| AppError::validation("storage.invalidPath"))?;
    }
    let mut result = parent.canonicalize()?;
    for part in missing.into_iter().rev() {
        result.push(part);
    }
    Ok(result)
}

/// Unlike exists(), this also detects broken links rather than treating them as empty data.
pub fn metadata(path: &Path) -> AppResult<Option<std::fs::Metadata>> {
    match std::fs::symlink_metadata(path) {
        Ok(value) => Ok(Some(value)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

pub fn linked(metadata: &std::fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    false
}

pub fn empty_target(path: &Path) -> AppResult<()> {
    if let Some(metadata) = metadata(path)? {
        if linked(&metadata) || !metadata.is_dir() || std::fs::read_dir(path)?.next().is_some() {
            return Err(AppError::validation("storage.targetNotEmpty"));
        }
    }
    Ok(())
}
