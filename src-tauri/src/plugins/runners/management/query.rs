use super::{
    super::{identity, repository, HostContext, Record},
    contracts::*,
};
use crate::{
    error::{AppError, AppResult},
    state::AppState,
};
use sha2::{Digest, Sha256};
use std::path::Path;
use tauri::{AppHandle, Manager};

pub(super) fn context(app: &AppHandle, id: &str) -> AppResult<HostContext> {
    if !crate::plugins::manifest::valid_id(id) {
        return Err(AppError::validation("plugin.invalidId"));
    }
    Ok(HostContext {
        app: app.clone(),
        id: id.into(),
        fingerprint: String::new(),
        permissions: vec![],
        generation: 0,
        tool_client: None,
        tool_request: None,
    })
}

pub(super) fn token(record: &Record) -> AppResult<String> {
    Ok(format!("{:x}", Sha256::digest(serde_json::to_vec(record)?)))
}

pub(super) fn selected(context: &HostContext, expected: &str) -> AppResult<Record> {
    let records = repository::read(context)?;
    Ok(records[super::mutation::index(&records, expected)?].clone())
}

pub(super) fn owners(directory: &Path) -> AppResult<Owners> {
    let mut entries = match std::fs::read_dir(directory) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Owners {
                ids: vec![],
                limited: false,
            })
        }
        Err(error) => return Err(error.into()),
    };
    let mut ids = Vec::new();
    for entry in entries.by_ref().take(4096) {
        let entry = entry?;
        if !entry.file_type()?.is_file() {
            continue;
        }
        let path = entry.path();
        if path.extension().is_none_or(|value| value != "json") {
            continue;
        }
        if let Some(id) = path
            .file_stem()
            .and_then(|value| value.to_str())
            .filter(|id| crate::plugins::manifest::valid_id(id))
        {
            ids.push(id.into());
        }
    }
    let limited = entries.next().is_some();
    ids.sort();
    ids.dedup();
    Ok(Owners { ids, limited })
}

pub(super) async fn snapshot(app: &AppHandle, id: &str, offset: usize) -> AppResult<Snapshot> {
    if offset > repository::MAX_RECORDS {
        return Err(AppError::validation("plugin.api.invalid:offset"));
    }
    let context = context(app, id)?;
    let mut records = repository::read(&context)?;
    records.sort_by(|a, b| {
        (&a.runner_id, &a.deployment.directory, &a.deployment.host_id).cmp(&(
            &b.runner_id,
            &b.deployment.directory,
            &b.deployment.host_id,
        ))
    });
    let total = records.len();
    let installed = app
        .state::<AppState>()
        .plugins
        .list()
        .await
        .into_iter()
        .find(|plugin| plugin.id == id);
    let sessions = identity::sessions(app);
    let state = app.state::<AppState>();
    let current = installed.as_ref().map(|plugin| plugin.fingerprint.as_str());
    let grant = installed.as_ref().is_some_and(|plugin| {
        state
            .plugins
            .security
            .authorize(
                id,
                &plugin.fingerprint,
                &plugin.permissions,
                Some("ssh.exec"),
                None,
            )
            .is_ok()
    });
    let entries = records
        .iter()
        .skip(offset)
        .take(32)
        .map(|record| super::projection::entry(record, &sessions, current, grant))
        .collect::<AppResult<Vec<_>>>()?;
    let end = offset.saturating_add(entries.len());
    Ok(Snapshot {
        plugin_id: id.into(),
        entries,
        total,
        next_offset: (end < total).then_some(end),
    })
}
