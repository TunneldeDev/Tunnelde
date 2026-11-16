//! Shared ordered activation. Stored source and selection are checked at commit.
mod contracts;
use super::repository;
use crate::{
    error::{AppError, AppResult},
    settings::Settings,
    state::AppState,
};
pub(crate) use contracts::{Apply, Snapshot};
use tauri::{AppHandle, Emitter, Manager};

pub(crate) fn publish(app: &AppHandle) {
    let _ = app.emit("settings-profiles://changed", ());
}

#[tauri::command]
pub async fn settings_profiles_snapshot(app: AppHandle) -> AppResult<Snapshot> {
    let worker_app = app.clone();
    crate::services::settings::write(&app, move |writer| {
        let state = worker_app.state::<AppState>();
        state.db.with(|conn| {
            writer.check()?;
            let saved = repository::read(conn)?;
            Ok(Snapshot {
                profiles: saved.profiles,
                revision: saved.revision,
                active_id: saved.active_id,
            })
        })
    })
    .await
}

#[tauri::command]
pub async fn settings_profile_apply(app: AppHandle, request: Apply) -> AppResult<Settings> {
    let worker_app = app.clone();
    crate::services::settings::write(&app, move |writer| {
        let state = worker_app.state::<AppState>();
        let (id, revision, values) = match request {
            Apply::Saved { id, revision } => {
                if id.is_empty()
                    || id.len() > 128
                    || id.chars().any(char::is_control)
                    || revision.len() != 68
                    || !revision.starts_with("pc1:")
                    || !revision[4..].bytes().all(|b| b.is_ascii_hexdigit())
                {
                    return Err(AppError::validation("profiles.invalidRequest"));
                }
                let selected = state.db.with(|conn| {
                    writer.check()?;
                    let saved = repository::check(conn, &revision)?;
                    saved
                        .profiles
                        .into_iter()
                        .find(|profile| profile.id == id)
                        .ok_or_else(|| AppError::NotFound("profiles.notFound".into()))
                })?;
                (
                    Some(id),
                    Some(revision),
                    super::normalize(selected.settings)?,
                )
            }
            Apply::Import { settings } => {
                if serde_json::to_vec(&settings)?.len() > super::MAX_FILE_BYTES {
                    return Err(AppError::validation("profiles.tooLarge"));
                }
                (None, None, super::normalize(settings)?)
            }
        };
        let mut prepared = writer.prepare_update(values)?;
        prepared.persist_with(|conn| {
            if let Some(revision) = revision {
                repository::check(conn, &revision)?;
            }
            repository::select(conn, id.as_deref())
        })?;
        let result = prepared.finish();
        publish(&worker_app);
        Ok(result)
    })
    .await
}
