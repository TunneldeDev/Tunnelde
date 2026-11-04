//! Portable preferences and named snapshots. No host, credential, workspace or plugin data.
use std::io::Read;

use rusqlite::{params, Connection, OptionalExtension};
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
    "terminalRightClick",
    "terminalRenderer",
    "fileIconTheme",
    "filesShowHidden",
    "filesFoldersFirst",
    "filesSortBy",
    "filesSortDirection",
    "transferOptimization",
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
    let raw: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![KEY],
            |row| row.get(0),
        )
        .optional()?;
    match raw {
        Some(raw) => {
            serde_json::from_str(&raw).map_err(|_| AppError::validation("profiles.invalidStorage"))
        }
        None => Ok(Vec::new()),
    }
}

fn save(conn: &Connection, profiles: &[SettingsProfile]) -> AppResult<()> {
    conn.execute(
        "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        params![KEY, serde_json::to_string(profiles)?, now_ms()],
    )?;
    Ok(())
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
    state: State<'_, AppState>,
    id: Option<String>,
    name: String,
    settings: Value,
) -> AppResult<Vec<SettingsProfile>> {
    state.db.with(|conn| upsert(conn, id, name, settings))
}

#[tauri::command]
pub fn settings_profile_delete(
    state: State<'_, AppState>,
    id: String,
) -> AppResult<Vec<SettingsProfile>> {
    state.db.with(|conn| {
        let mut profiles = load(conn)?;
        let before = profiles.len();
        profiles.retain(|profile| profile.id != id);
        if profiles.len() == before {
            return Err(AppError::NotFound("profiles.notFound".into()));
        }
        save(conn, &profiles)?;
        Ok(profiles)
    })
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
    // Bound reads, even if the selected file grows or is a special filesystem entry.
    let mut text = String::new();
    std::fs::File::open(std::path::PathBuf::from(path.to_string()))?
        .take((MAX_FILE_BYTES + 1) as u64)
        .read_to_string(&mut text)?;
    Ok(Some(parse_document(&text)?))
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
    std::fs::write(&target, text)?;
    Ok(Some(target.to_string_lossy().into_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;

    #[test]
    fn background_dock_preference_is_portable_and_legacy_profiles_keep_default() {
        assert_eq!(
            normalize(serde_json::json!({"theme":"dark"})).unwrap()["showDockIconInBackground"],
            true
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
            skipped_version: Some("1.0.0".into()),
            last_update_check: Some(123),
            ..Settings::default()
        };
        let value = portable(&settings).unwrap();
        assert!(value.get("skippedVersion").is_none());
        assert!(value.get("lastUpdateCheck").is_none());
        assert!(value.get("hosts").is_none());
        assert!(value.get("password").is_none());
        assert_eq!(normalize(value.clone()).unwrap(), value);
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
