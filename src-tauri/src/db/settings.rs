// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

use rusqlite::{params, Connection, OptionalExtension};

use crate::error::AppResult;
use crate::models::now_ms;
use crate::settings::Settings;

const SETTINGS_KEY: &str = "app";

pub fn load(conn: &Connection) -> AppResult<Settings> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![SETTINGS_KEY],
            |row| row.get(0),
        )
        .optional()?;

    match raw {
        Some(json) => Ok(serde_json::from_str(&json).unwrap_or_default()),
        None => Ok(Settings::default()),
    }
}

pub fn save(conn: &Connection, settings: &Settings) -> AppResult<()> {
    let json = serde_json::to_string(settings)?;
    conn.execute(
        "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        params![SETTINGS_KEY, json, now_ms()],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::Database;

    fn load_json(raw: &str) -> Settings {
        let database = Database::in_memory().expect("database");
        database
            .with(|conn| {
                conn.execute(
                    "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, 0)",
                    params![SETTINGS_KEY, raw],
                )?;
                load(conn)
            })
            .expect("load settings")
    }

    #[test]
    fn ignores_removed_menu_preferences_without_losing_other_settings() {
        for legacy in [true, false] {
            let settings = load_json(&format!(
                r##"{{"nativeMenu":{legacy},"menuMode":"both","theme":"light","accent":"#123456"}}"##
            ));
            assert_eq!(settings.theme, "light");
            assert_eq!(settings.accent, "#123456");
            let serialized = serde_json::to_value(settings).expect("settings");
            assert!(serialized.get("nativeMenu").is_none());
            assert!(serialized.get("menuMode").is_none());
        }
    }

    #[test]
    fn new_and_corrupt_settings_use_current_defaults() {
        let database = Database::in_memory().expect("database");
        let fresh = database.with(load).expect("fresh settings");
        let corrupt = load_json("invalid json");
        let defaults = Settings::default();
        assert_eq!(fresh.theme, defaults.theme);
        assert_eq!(corrupt.theme, defaults.theme);
        assert_eq!(corrupt.language, defaults.language);
    }

    #[test]
    fn persists_settings_through_save_and_load() {
        let database = Database::in_memory().expect("database");
        for language in ["system", "zh-CN", "en-US"] {
            let mut settings = Settings {
                language: language.into(),
                ..Settings::default()
            };
            settings.sanitize();
            let restored = database
                .with(|conn| {
                    save(conn, &settings)?;
                    load(conn)
                })
                .expect("saved settings");
            assert_eq!(restored.language, language);
        }
    }
}
