use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::layout::Category;
use crate::error::{AppError, AppResult};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Change {
    pub category: Category,
    pub target: PathBuf,
    #[serde(default = "default_migrate")]
    pub migrate: bool,
}
fn default_migrate() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pending {
    pub id: String,
    pub changes: Vec<Change>,
    #[serde(default, skip_serializing_if = "Action::is_apply")]
    pub action: Action,
}

/// The persisted direction wins after a process restart. Older plans apply.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Action {
    #[default]
    Apply,
    Cancel,
}
impl Action {
    fn is_apply(&self) -> bool {
        *self == Self::Apply
    }
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    pub locations: BTreeMap<Category, PathBuf>,
    pub pending: Option<Pending>,
    pub previous: BTreeMap<Category, PathBuf>,
    pub archives: BTreeMap<Category, PathBuf>,
    pub last_error: Option<String>,
}

pub fn load(home: &Path) -> AppResult<Config> {
    use std::io::Read;
    let path = home.join("storage.json");
    match std::fs::File::open(path) {
        Ok(file) => {
            let mut bytes = vec![];
            file.take(128 * 1024 + 1).read_to_end(&mut bytes)?;
            if bytes.len() > 128 * 1024 {
                return Err(AppError::validation("storage.invalidConfig"));
            }
            serde_json::from_slice(&bytes)
                .map_err(|_| AppError::validation("storage.invalidConfig"))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Config::default()),
        Err(error) => Err(error.into()),
    }
}

/// Synced temporary metadata; publishing is a separate, short commit step.
pub(super) struct Prepared {
    temporary: PathBuf,
    destination: PathBuf,
}
impl Prepared {
    pub(super) fn publish(&self) -> AppResult<()> {
        std::fs::rename(&self.temporary, &self.destination)?;
        Ok(())
    }
}
impl Drop for Prepared {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.temporary);
    }
}
pub(super) fn prepare(home: &Path, config: &Config) -> AppResult<Prepared> {
    use std::io::Write;
    let bytes = serde_json::to_vec_pretty(config)?;
    if bytes.len() > 128 * 1024 {
        return Err(AppError::validation("storage.invalidConfig"));
    }
    std::fs::create_dir_all(home)?;
    let temporary = home.join(format!(".storage-{}.tmp", uuid::Uuid::new_v4()));
    let mut file = std::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temporary)?;
    let prepared = Prepared {
        temporary,
        destination: home.join("storage.json"),
    };
    file.write_all(&bytes)?;
    file.sync_all()?;
    Ok(prepared)
}
pub fn save(home: &Path, config: &Config) -> AppResult<()> {
    prepare(home, config)?.publish()
}
