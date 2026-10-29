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
