use crate::plugins::api::{authorize, field, HostContext};
use crate::{
    error::{AppError, AppResult},
    state::AppState,
};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    sync::OnceLock,
};
use tauri::Manager;
use tokio::io::AsyncReadExt;

mod secrets;
pub(in crate::plugins::api) use secrets::dispatch as secret;
pub(in crate::plugins::api) const MAX_STORAGE: usize = 256 * 1024;

pub(in crate::plugins::api) fn storage_path(root: &Path, id: &str) -> PathBuf {
    root.join(format!("{:x}.json", Sha256::digest(id.as_bytes())))
}

fn storage_key(params: &Value) -> AppResult<String> {
    let key: String = field(params, "key")?;
    if key.is_empty()
        || key.len() > 128
        || !key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
        || ["__proto__", "constructor", "prototype"].contains(&key.as_str())
    {
        return Err(AppError::validation("plugin.api.invalidStorageKey"));
    }
    Ok(key)
}

pub(in crate::plugins::api) async fn dispatch(
    context: &HostContext,
    method: &str,
    params: &Value,
) -> AppResult<Value> {
    let root = context
        .app
        .state::<AppState>()
        .storage
        .dir(crate::storage::layout::Category::PluginData)
        .to_path_buf();
    storage_at(&root, &context.id, method, params, || {
        authorize(context, &[])
    })
    .await
}

pub(in crate::plugins::api) async fn storage_at(
    root: &Path,
    id: &str,
    method: &str,
    params: &Value,
    authorize_request: impl Fn() -> AppResult<()>,
) -> AppResult<Value> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    if !matches!(method, "storage.get" | "storage.set" | "storage.delete") {
        return Err(AppError::validation("plugin.api.unknownMethod"));
    }
    let key = storage_key(params)?;
    let _guard = LOCK
        .get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await;
    authorize_request()?;
    let path = storage_path(root, id);
    let mut values: Map<String, Value> = match tokio::fs::File::open(&path).await {
        Ok(file) => {
            let mut bytes = Vec::new();
            file.take(MAX_STORAGE as u64 + 1)
                .read_to_end(&mut bytes)
                .await?;
            if bytes.len() > MAX_STORAGE {
                return Err(AppError::validation("plugin.api.storageTooLarge"));
            }
            serde_json::from_slice(&bytes)
                .map_err(|_| AppError::validation("plugin.api.invalidStorage"))?
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Map::new(),
        Err(error) => return Err(error.into()),
    };
    if method == "storage.get" {
        return Ok(values.get(&key).cloned().unwrap_or(Value::Null));
    }
    if method == "storage.set" {
        values.insert(key, field(params, "value")?);
    } else {
        values.remove(&key);
    }
    let bytes = serde_json::to_vec(&values)?;
    if bytes.len() > MAX_STORAGE {
        return Err(AppError::validation("plugin.api.storageTooLarge"));
    }
    let root = path
        .parent()
        .ok_or_else(|| AppError::internal("plugin.api.storagePath"))?;
    tokio::fs::create_dir_all(root).await?;
    let temporary = root.join(format!(".{}.tmp", uuid::Uuid::new_v4()));
    let result = async {
        tokio::fs::write(&temporary, bytes).await?;
        authorize_request()?;
        tokio::fs::rename(&temporary, &path).await?;
        Ok(Value::Null)
    }
    .await;
    if result.is_err() {
        let _ = tokio::fs::remove_file(&temporary).await;
    }
    result
}

#[cfg(test)]
mod tests;
