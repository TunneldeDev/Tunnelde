use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use super::network::validate_url;
use crate::error::{AppError, AppResult};

pub const OFFICIAL_URL: &str =
    "https://raw.githubusercontent.com/TunneldeDev/tunnelde-hub/main/registry.json";
pub const LEGACY_OFFICIAL_URL: &str =
    "https://raw.githubusercontent.com/TunneldeDev/Tunnelde/main/marketplace/index.json";

pub fn migrate_official_source(source: &mut MarketSource) {
    if source.id == "official" && source.url == LEGACY_OFFICIAL_URL {
        source.url = OFFICIAL_URL.into();
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MarketSource {
    pub id: String,
    pub name: String,
    pub url: String,
    pub enabled: bool,
}

pub fn official() -> MarketSource {
    MarketSource {
        id: "official".into(),
        name: "Tunnelde".into(),
        url: OFFICIAL_URL.into(),
        enabled: true,
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct PluginConfig {
    pub sources: Vec<MarketSource>,
    pub node_path: Option<String>,
    pub node_system_allowed: bool,
}

impl Default for PluginConfig {
    fn default() -> Self {
        Self {
            sources: vec![official()],
            node_path: None,
            node_system_allowed: false,
        }
    }
}

impl PluginConfig {
    pub fn validate(&self) -> AppResult<()> {
        let mut ids = std::collections::HashSet::new();
        let mut urls = std::collections::HashSet::new();
        if self.sources.len() > 20 {
            return Err(AppError::validation("market.sourceLimit"));
        }
        for source in &self.sources {
            if !super::manifest::valid_id(&source.id)
                || !ids.insert(&source.id)
                || source.name.trim().is_empty()
                || source.name.len() > 120
            {
                return Err(AppError::validation("market.invalidSource"));
            }
            let url = validate_url(&source.url)?;
            if !urls.insert(url.to_string()) {
                return Err(AppError::validation("market.duplicateSource"));
            }
            if source.id == "official" && source.url != OFFICIAL_URL {
                return Err(AppError::validation("market.officialImmutable"));
            }
        }
        if !ids.contains(&"official".to_string()) {
            return Err(AppError::validation("market.officialImmutable"));
        }
        Ok(())
    }
}

pub fn load(conn: &Connection) -> AppResult<PluginConfig> {
    let raw: Option<String> = conn
        .query_row(
            "SELECT value FROM settings WHERE key = 'plugins'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    Ok(raw
        .and_then(|s| serde_json::from_str(&s).ok())
        .map(|mut config: PluginConfig| {
            for source in &mut config.sources {
                migrate_official_source(source);
            }
            config
        })
        .filter(|config: &PluginConfig| config.validate().is_ok())
        .unwrap_or_default())
}

pub fn save(conn: &Connection, config: &PluginConfig) -> AppResult<()> {
    config.validate()?;
    conn.execute("INSERT INTO settings (key,value,updated_at) VALUES ('plugins',?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at",
        params![serde_json::to_string(config)?, crate::models::now_ms()])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn migration_preserves_runtime_consent_and_custom_sources() {
        let db = crate::db::Database::in_memory().unwrap();
        db.with(|conn| {
            let mut config = PluginConfig {
                node_path: Some("/chosen/node".into()),
                node_system_allowed: true,
                ..PluginConfig::default()
            };
            config.sources[0].url = LEGACY_OFFICIAL_URL.into();
            config.sources[0].enabled = false;
            config.sources.push(MarketSource {
                id: "custom".into(),
                name: "Custom".into(),
                url: "https://example.org/registry.json".into(),
                enabled: true,
            });
            conn.execute(
                "INSERT INTO settings (key,value,updated_at) VALUES ('plugins',?1,0)",
                [serde_json::to_string(&config)?],
            )?;
            let loaded = load(conn)?;
            assert_eq!(loaded.sources[0].url, OFFICIAL_URL);
            assert!(!loaded.sources[0].enabled);
            assert_eq!(loaded.sources[1], config.sources[1]);
            assert_eq!(loaded.node_path, config.node_path);
            assert!(loaded.node_system_allowed);
            Ok(())
        })
        .unwrap();
    }
    #[test]
    fn rejects_duplicate_urls_and_official_replacement() {
        let mut c = PluginConfig::default();
        c.sources.push(MarketSource {
            id: "custom".into(),
            ..official()
        });
        assert!(c.validate().is_err());
        c.sources.pop();
        c.sources[0].url = "https://example.org/index.json".into();
        assert!(c.validate().is_err());
    }
    #[test]
    fn plugin_config_is_independent_from_appearance_reset() {
        let db = crate::db::Database::in_memory().unwrap();
        db.with(|conn| {
            let c = PluginConfig {
                node_path: Some("/custom/node".into()),
                ..PluginConfig::default()
            };
            save(conn, &c)?;
            crate::db::settings::save(conn, &crate::settings::Settings::default())?;
            assert_eq!(load(conn)?.node_path, c.node_path);
            Ok(())
        })
        .unwrap();
    }
}
