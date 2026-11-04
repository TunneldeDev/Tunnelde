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
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Config {
    pub locations: BTreeMap<Category, PathBuf>,
    pub pending: Option<Pending>,
    pub previous: BTreeMap<Category, PathBuf>,
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

pub fn save(home: &Path, config: &Config) -> AppResult<()> {
    use std::io::Write;
    std::fs::create_dir_all(home)?;
    let temporary = home.join(format!(".storage-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)?;
        file.write_all(&serde_json::to_vec_pretty(config)?)?;
        file.sync_all()?;
        std::fs::rename(&temporary, home.join("storage.json"))?;
        Ok::<_, AppError>(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(temporary);
    }
    result
}
