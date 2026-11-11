//! Portable preferences and named snapshots. No host, credential, workspace or plugin data.
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::error::{AppError, AppResult};
use crate::models::now_ms;
use crate::settings::Settings;
use crate::state::AppState;

const KEY: &str = "settings.profiles.v1";
const FORMAT: &str = "tunnelde-settings";
const MAX_FILE_BYTES: usize = 512_000;
const MAX_PROFILES: usize = 32;

pub(crate) mod activation;
pub(crate) mod content;
mod files;
pub(crate) mod observation;
mod repository;

// Deliberately explicit: newly added settings never become portable by accident.
const PORTABLE_KEYS: &[&str] = &[
    "network",
    "language",
    "theme",
    "accent",
    "colors",
    "density",
    "uiFontSize",
    "monoFontSize",
    "monoFont",
    "sidebarWidth",
    "rightPanel",
    "rightPanelWidth",
    "userCss",
    "autoCheckUpdates",
    "updateChannel",
    "updateSource",
    "updateSourceUrl",
    "updateCheckInterval",
    "closeToTray",
    "releaseWebviewInTray",
    "lightweightMode",
    "showDockIconInBackground",
    "titleBarStyle",
    "recordTerminalHistory",
    "preloadDirs",
    "preloadCount",
    "motion",
    "showStatusBar",
    "uiProviders",
    "hostList",
    "restoreWorkspace",
    "hostActivation",
    "hostDirectConnect",
    "terminalScrollback",
    "terminalLineHeight",
    "terminalCursorStyle",
    "terminalCursorBlink",
    "terminalInactiveCursorStyle",
    "terminalScrollSensitivity",
    "terminalSmoothScrolling",
    "terminalScrollOnInput",
    "terminalCopyOnSelect",
    "terminalApplicationClipboard",
    "terminalRightClick",
    "terminalRenderer",
    "fileIconTheme",
    "filesShowHidden",
    "filesFoldersFirst",
    "filesSortBy",
    "filesSortDirection",
    "transferOptimization",
    "transferCompression",
    "transferConcurrency",
    "transferChunkKib",
    "transferRequests",
    "transferUploadLimitKib",
    "transferDownloadLimitKib",
    "editorWordWrap",
    "editorTabSize",
    "editorSpellCheck",
    "monitorIntervalMs",
    "keyboardShortcuts",
    "shortcutRules",
    "showShortcutDetails",
];

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SettingsProfile {
    pub id: String,
    pub name: String,
    pub settings: Value,
    pub updated_at: i64,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SettingsDocument {
    pub format: String,
    pub version: u32,
    pub name: String,
    pub settings: Value,
}

fn portable(settings: &Settings) -> AppResult<Value> {
    let serialized = serde_json::to_value(settings)?;
    Ok(Value::Object(
        PORTABLE_KEYS
            .iter()
            .filter_map(|key| {
                serialized
                    .get(*key)
                    .map(|value| ((*key).into(), value.clone()))
            })
            .collect(),
    ))
}

fn validate_name(name: &str) -> AppResult<String> {
    let name = name.trim();
    if name.is_empty() || name.chars().count() > 64 || name.chars().any(char::is_control) {
        return Err(AppError::validation("profiles.invalidName"));
    }
    Ok(name.to_owned())
}

/// Reject invalid/unknown values instead of silently repairing a downloaded configuration.
fn normalize(value: Value) -> AppResult<Value> {
    let input = value
        .as_object()
        .filter(|input| !input.is_empty())
        .ok_or_else(|| AppError::validation("profiles.invalidFile"))?;
    if input
        .keys()
        .any(|key| !PORTABLE_KEYS.contains(&key.as_str()))
    {
        return Err(AppError::validation("profiles.unknownSetting"));
    }
    let mut settings: Settings =
        serde_json::from_value(value).map_err(|_| AppError::validation("profiles.invalidFile"))?;
    let css = settings.user_css.to_ascii_lowercase();
    if css.contains("@import")
        || css.match_indices("url(").any(|(start, _)| {
            let url = css[start + 4..]
                .trim_start()
                .trim_start_matches(['\'', '"']);
            url.starts_with("http://") || url.starts_with("https://") || url.starts_with("//")
        })
    {
        return Err(AppError::validation("settings.cssRejected"));
    }
    let original = serde_json::to_value(&settings)?;
    settings.sanitize();
    settings.network.validate()?;
    crate::update::validate_preferences(&settings)?;
    if original != serde_json::to_value(&settings)? {
        return Err(AppError::validation("profiles.invalidValue"));
    }
    portable(&settings)
}

fn parse_document(text: &str) -> AppResult<SettingsDocument> {
    if text.len() > MAX_FILE_BYTES {
        return Err(AppError::validation("profiles.tooLarge"));
    }
    let mut document: SettingsDocument =
        serde_json::from_str(text).map_err(|_| AppError::validation("profiles.invalidFile"))?;
    if document.format != FORMAT || document.version != 1 {
        return Err(AppError::validation("profiles.unsupportedVersion"));
    }
    document.name = validate_name(&document.name)?;
    document.settings = normalize(document.settings)?;
    Ok(document)
}

fn load(conn: &Connection) -> AppResult<Vec<SettingsProfile>> {
    Ok(repository::read(conn)?.profiles)
}

fn save(conn: &Connection, profiles: &[SettingsProfile]) -> AppResult<()> {
    repository::save(conn, profiles)
}

fn upsert(
    conn: &Connection,
    id: Option<String>,
    name: String,
    settings: Value,
) -> AppResult<Vec<SettingsProfile>> {
    let name = validate_name(&name)?;
    let settings = normalize(settings)?;
    let mut profiles = load(conn)?;
    if profiles.iter().any(|profile| {
        Some(&profile.id) != id.as_ref() && profile.name.to_lowercase() == name.to_lowercase()
    }) {
        return Err(AppError::validation("profiles.duplicateName"));
    }
    if let Some(id) = id {
        let profile = profiles
            .iter_mut()
            .find(|profile| profile.id == id)
            .ok_or_else(|| AppError::NotFound("profiles.notFound".into()))?;
        profile.name = name;
        profile.settings = settings;
        profile.updated_at = now_ms();
    } else {
        if profiles.len() >= MAX_PROFILES {
            return Err(AppError::validation("profiles.limit"));
        }
        profiles.push(SettingsProfile {
            id: uuid::Uuid::new_v4().to_string(),
            name,
            settings,
            updated_at: now_ms(),
        });
    }
    save(conn, &profiles)?;
    Ok(profiles)
}

#[tauri::command]
pub fn settings_profiles_list(state: State<'_, AppState>) -> AppResult<Vec<SettingsProfile>> {
    state.db.with(load)
}

#[tauri::command]
pub fn settings_profile_save(
    app: AppHandle,
    state: State<'_, AppState>,
    id: Option<String>,
    name: String,
    settings: Value,
) -> AppResult<Vec<SettingsProfile>> {
    let profiles = state.db.with(|conn| upsert(conn, id, name, settings))?;
    activation::publish(&app);
    Ok(profiles)
}

#[tauri::command]
pub fn settings_profile_delete(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> AppResult<Vec<SettingsProfile>> {
    let profiles = state.db.with(|conn| {
        let mut profiles = load(conn)?;
        let before = profiles.len();
        profiles.retain(|profile| profile.id != id);
        if profiles.len() == before {
            return Err(AppError::NotFound("profiles.notFound".into()));
        }
        save(conn, &profiles)?;
        Ok(profiles)
    })?;
    activation::publish(&app);
    Ok(profiles)
}

#[tauri::command]
pub async fn settings_file_import(app: AppHandle) -> AppResult<Option<SettingsDocument>> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter("Tunnelde settings", &["json"])
        .pick_file(move |path| {
            let _ = tx.send(path);
        });
    let picked = rx
        .await
        .map_err(|_| AppError::internal("dialog.cancelled"))?;
    let Some(path) = picked else {
        return Ok(None);
    };
    let path = std::path::PathBuf::from(path.to_string());
    let document = tauri::async_runtime::spawn_blocking(move || files::read(&path))
        .await
        .map_err(|error| AppError::internal(error.to_string()))??;
    Ok(Some(document))
}

#[tauri::command]
pub async fn settings_file_export(
    app: AppHandle,
    name: String,
    settings: Value,
) -> AppResult<Option<String>> {
    let document = SettingsDocument {
        format: FORMAT.into(),
        version: 1,
        name: validate_name(&name)?,
        settings: normalize(settings)?,
    };
    let text = serde_json::to_string_pretty(&document)?;
    if text.len() > MAX_FILE_BYTES {
        return Err(AppError::validation("profiles.tooLarge"));
    }
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter("Tunnelde settings", &["json"])
        .set_file_name("tunnelde-settings.json")
        .save_file(move |path| {
            let _ = tx.send(path);
        });
    let picked = rx
        .await
        .map_err(|_| AppError::internal("dialog.cancelled"))?;
    let Some(path) = picked else {
        return Ok(None);
    };
    let target = std::path::PathBuf::from(path.to_string());
    let saved = tauri::async_runtime::spawn_blocking(move || {
        files::write(&target, text.as_bytes())?;
        Ok::<_, AppError>(target.to_string_lossy().into_owned())
    })
    .await
    .map_err(|error| AppError::internal(error.to_string()))??;
    Ok(Some(saved))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;

    #[test]
    fn full_profile_preserves_terminal_clipboard_and_advanced_shortcut_preferences() {
        let settings: Settings = serde_json::from_value(serde_json::json!({
            "terminalApplicationClipboard": false,
            "shortcutRules": {"terminal.paste":{"Mod+V":{"priority":300,"propagation":"continue"}}},
            "showShortcutDetails": true
        }))
        .unwrap();
        let snapshot = portable(&settings).unwrap();
        let parsed = normalize(snapshot.clone()).unwrap();
        assert_eq!(parsed, snapshot);
        assert_eq!(parsed["terminalApplicationClipboard"], false);
        assert_eq!(
            parsed["shortcutRules"]["terminal.paste"]["Mod+V"]["priority"],
            300
        );
        assert_eq!(parsed["showShortcutDetails"], true);
        let db = Database::in_memory().unwrap();
        db.with(|conn| {
            let profiles = upsert(conn, None, "Complete profile".into(), snapshot.clone())?;
            assert_eq!(load(conn)?[0].settings, snapshot);
            let document = SettingsDocument {
                format: FORMAT.into(),
                version: 1,
                name: profiles[0].name.clone(),
                settings: profiles[0].settings.clone(),
            };
            assert_eq!(
                parse_document(&serde_json::to_string(&document)?)?.settings,
                snapshot
            );
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn background_dock_preference_is_portable_and_legacy_profiles_keep_default() {
        assert_eq!(
            normalize(serde_json::json!({"theme":"dark"})).unwrap()["showDockIconInBackground"],
            false
        );
        let settings = Settings {
            show_dock_icon_in_background: false,
            ..Settings::default()
        };
        let snapshot = portable(&settings).unwrap();
        assert_eq!(snapshot["showDockIconInBackground"], false);
        assert_eq!(normalize(snapshot.clone()).unwrap(), snapshot);
    }

    #[test]
    fn portable_snapshot_excludes_runtime_metadata_and_all_unrelated_data() {
        let settings = Settings {
            transfer_compression: false,
            skipped_version: Some("1.0.0".into()),
            last_update_check: Some(123),
            ..Settings::default()
        };
        let value = portable(&settings).unwrap();
        assert!(value.get("skippedVersion").is_none());
        assert!(value.get("lastUpdateCheck").is_none());
        assert!(value.get("hosts").is_none());
        assert!(value.get("password").is_none());
        assert_eq!(value["transferCompression"], false);
        assert_eq!(normalize(value.clone()).unwrap(), value);
        let preferences = serde_json::json!({"view":"table","order":["name","plugin/inventory/cost"],"hidden":["port"],"widths":{"plugin/inventory/cost":195},"sort":{"key":"plugin/inventory/cost","direction":"desc"}});
        let imported = normalize(serde_json::json!({"hostList":preferences})).unwrap();
        assert_eq!(imported["hostList"], preferences);
        assert_eq!(normalize(imported.clone()).unwrap(), imported);
    }

    #[test]
    fn rejects_unsupported_invalid_and_secret_fields() {
        for value in [
            serde_json::json!({}),
            serde_json::json!({"password":"secret"}),
            serde_json::json!({"theme":"unknown"}),
            serde_json::json!({"uiFontSize":900}),
            serde_json::json!({"rightPanel":"false"}),
            serde_json::json!({"lastUpdateCheck": 1}),
        ] {
            assert!(normalize(value).is_err());
        }
        for text in [
            "{}",
            r#"{"format":"tunnelde-settings","version":2,"name":"Test","settings":{"theme":"dark"}}"#,
        ] {
            assert!(parse_document(text).is_err());
        }
        assert!(parse_document(&" ".repeat(MAX_FILE_BYTES + 1)).is_err());
    }

    #[test]
    fn round_trips_document_and_fills_omitted_preferences() {
        let text = r#"{"format":"tunnelde-settings","version":1,"name":"Work","settings":{"theme":"dark"}}"#;
        let doc = parse_document(text).unwrap();
        assert_eq!(doc.settings["theme"], "dark");
        assert!(doc.settings.get("monoFont").is_some());
        assert_eq!(doc.settings["transferCompression"], true);
        assert_eq!(
            parse_document(&serde_json::to_string(&doc).unwrap())
                .unwrap()
                .settings,
            doc.settings
        );
    }

    #[test]
    fn snapshots_are_persistent_unique_bounded_and_separate_from_current_settings() {
        let db = Database::in_memory().unwrap();
        db.with(|conn| {
            let snapshot = portable(&Settings::default())?;
            let first = upsert(conn, None, "Work".into(), snapshot.clone())?;
            let id = first[0].id.clone();
            assert!(upsert(conn, None, " work ".into(), snapshot.clone()).is_err());
            assert!(upsert(conn, None, "\n".into(), snapshot.clone()).is_err());
            assert!(upsert(
                conn,
                Some("missing".into()),
                "Other".into(),
                snapshot.clone()
            )
            .is_err());
            let updated = upsert(
                conn,
                Some(id.clone()),
                "Renamed".into(),
                serde_json::json!({"theme":"light"}),
            )?;
            assert_eq!(updated.len(), 1);
            assert_eq!(load(conn)?[0].id, id);
            assert_eq!(load(conn)?[0].settings["theme"], "light");
            assert_eq!(
                crate::db::settings::load(conn)?.theme,
                Settings::default().theme
            );
            for index in 1..MAX_PROFILES {
                upsert(conn, None, format!("Profile {index}"), snapshot.clone())?;
            }
            assert!(upsert(conn, None, "Too many".into(), snapshot).is_err());
            Ok(())
        })
        .unwrap();
    }
}
