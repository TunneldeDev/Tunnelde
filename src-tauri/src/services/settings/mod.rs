//! Application preferences shared by native commands, plugin RPCs and update metadata.
//! Internal legacy DTOs and versioned public preferences keep separate contracts.
mod effects;
mod mutation;
mod patch;
pub(crate) mod preferences;
pub(crate) mod read;
mod repository;

use crate::{error::AppResult, settings::Settings, state::AppState};
pub(crate) use mutation::run as write;
use serde_json::Value;
use tauri::AppHandle;

pub fn read(state: &AppState) -> Settings {
    state.settings()
}

pub async fn update(app: &AppHandle, patch: Value) -> AppResult<Settings> {
    write(app, move |writer| writer.update(patch)).await
}

pub async fn reset(app: &AppHandle) -> AppResult<Settings> {
    write(app, |writer| {
        writer.commit(mutation::Kind::Preferences, |_| {
            let mut next = Settings::default();
            next.sanitize();
            Ok(next)
        })
    })
    .await
}

pub async fn record_update_check(app: &AppHandle, timestamp: i64) -> AppResult<()> {
    write(app, move |writer| {
        writer.commit(mutation::Kind::Metadata, |previous| {
            let mut next = previous.clone();
            next.last_update_check = Some(timestamp);
            Ok(next)
        })
    })
    .await?;
    Ok(())
}
