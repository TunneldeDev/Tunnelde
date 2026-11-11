//! One lock and one file format for historical KV operations and conditional reads.
use super::{storage_key, storage_path, MAX_STORAGE};
use crate::error::{AppError, AppResult};
use crate::plugins::api::field;
use serde_json::{Map, Value};
use std::{path::Path, sync::OnceLock};
use tokio::io::AsyncReadExt;

pub(in crate::plugins::api) async fn storage_at(
    root: &Path,
    id: &str,
    method: &str,
    params: &Value,
    authorize_request: impl Fn() -> AppResult<()>,
) -> AppResult<Value> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    if !matches!(
        method,
        "storage.get" | "storage.set" | "storage.delete" | "storage.observe"
    ) {
        return Err(AppError::validation("plugin.api.unknownMethod"));
    }
    let observation = if method == "storage.observe" {
        Some(
            serde_json::from_value::<super::observation::contracts::Observe>(params.clone())
                .map_err(|_| AppError::validation("plugin.api.invalid:params"))?,
        )
    } else {
        None
    };
    let key = if observation.is_some() {
        None
    } else {
        Some(storage_key(params)?)
    };
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
    if let Some(request) = observation {
        let response = super::observation::project(id, values, request)?;
        authorize_request()?;
        return Ok(response);
    }
    let key = key.ok_or_else(|| AppError::internal("plugin.api.invalidStorageKey"))?;
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
