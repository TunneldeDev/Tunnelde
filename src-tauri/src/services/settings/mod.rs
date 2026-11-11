//! Application preferences shared by native commands, plugin RPCs and update metadata.
//! Existing RPC DTOs remain a compatibility boundary until the public settings contract lands.
mod effects;
mod mutation;
mod patch;
pub(crate) mod preferences;
mod repository;

use crate::{error::AppResult, settings::Settings, state::AppState};
pub(crate) use mutation::writer;
use serde_json::Value;
use tauri::{AppHandle, Manager};

pub fn read(state: &AppState) -> Settings {
    state.settings()
}

pub async fn update(app: &AppHandle, patch: Value) -> AppResult<Settings> {
    let state = app.state::<AppState>();
    writer(app, &state).await.update(patch)
}

pub async fn reset(app: &AppHandle) -> AppResult<Settings> {
    let state = app.state::<AppState>();
    writer(app, &state)
        .await
        .commit(mutation::Kind::Preferences, |_| {
            let mut next = Settings::default();
            next.sanitize();
            Ok(next)
        })
}

pub async fn record_update_check(app: &AppHandle, timestamp: i64) -> AppResult<()> {
    let state = app.state::<AppState>();
    writer(app, &state)
        .await
        .commit(mutation::Kind::Metadata, |previous| {
            let mut next = previous.clone();
            next.last_update_check = Some(timestamp);
            Ok(next)
        })?;
    Ok(())
}
