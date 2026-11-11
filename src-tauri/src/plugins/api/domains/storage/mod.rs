mod locations;
mod operation;
mod recovery;
use crate::plugins::api::{authorize, field, HostContext};
use crate::{
    error::{AppError, AppResult},
    state::AppState,
};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use tauri::Manager;

mod observation;
mod repository;
pub(in crate::plugins::api) use repository::storage_at;
mod secrets;
pub(in crate::plugins::api) use secrets::dispatch as secret;
pub(in crate::plugins::api) const MAX_STORAGE: usize = 256 * 1024;

pub(in crate::plugins::api) fn storage_path(root: &Path, id: &str) -> PathBuf {
    root.join(format!("{:x}.json", Sha256::digest(id.as_bytes())))
}

fn storage_key(params: &Value) -> AppResult<String> {
    let key: String = field(params, "key")?;
    if !valid_storage_key(&key) {
        return Err(AppError::validation("plugin.api.invalidStorageKey"));
    }
    Ok(key)
}

fn valid_storage_key(key: &str) -> bool {
    !key.is_empty()
        && key.len() <= 128
        && key
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
        && !["__proto__", "constructor", "prototype"].contains(&key)
}

pub(in crate::plugins::api) async fn dispatch(
    context: &HostContext,
    method: &str,
    params: &Value,
) -> AppResult<Value> {
    if method.starts_with("storage.recovery.") {
        return recovery::dispatch(context, method, params.clone()).await;
    }
    if method.starts_with("storage.locations.") {
        return locations::dispatch(context, method, params.clone()).await;
    }
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

#[cfg(test)]
mod tests;
