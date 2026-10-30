// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

pub const AUTH_METHODS: [&str; 4] = ["password", "key", "agent", "keyboardInteractive"];

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
    pub sort_order: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Host {
    pub id: String,
    pub group_id: Option<String>,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: String,
    pub key_path: Option<String>,
    pub favorite: bool,
    pub color: Option<String>,
    pub tags: Vec<String>,
    pub note: Option<String>,
    pub sort_order: i64,
    pub last_used_at: Option<i64>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostInput {
    pub name: String,
    #[serde(default)]
    pub group_id: Option<String>,
    pub host: String,
    #[serde(default)]
    pub port: Option<u16>,
    #[serde(default)]
    pub username: Option<String>,
    #[serde(default)]
    pub auth_method: Option<String>,
    #[serde(default)]
    pub key_path: Option<String>,
    #[serde(default)]
    pub favorite: bool,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub note: Option<String>,
}

/// Validated, normalized host fields ready for persistence.
#[derive(Debug, Clone)]
pub struct HostDraft {
    pub group_id: Option<String>,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: String,
    pub key_path: Option<String>,
    pub favorite: bool,
    pub color: Option<String>,
    pub tags: Vec<String>,
    pub note: Option<String>,
}

fn clean_optional(value: Option<String>, max: usize) -> Option<String> {
    let text = value?.trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(text.chars().take(max).collect())
    }
}

fn valid_color(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 7 && bytes[0] == b'#' && bytes[1..].iter().all(|b| b.is_ascii_hexdigit())
}

impl HostInput {
    pub fn validate(self) -> AppResult<HostDraft> {
        let name = self.name.trim().to_string();
        if name.is_empty() {
            return Err(AppError::validation("host.name.required"));
        }
        if name.chars().count() > 80 {
            return Err(AppError::validation("host.name.tooLong"));
        }

        let host = self.host.trim().to_string();
        if host.is_empty() {
            return Err(AppError::validation("host.address.required"));
        }
        if host.chars().count() > 255 {
            return Err(AppError::validation("host.address.tooLong"));
        }
        if host
            .chars()
            .any(|c| c.is_whitespace() || matches!(c, '/' | '\\' | '"' | '\''))
        {
            return Err(AppError::validation("host.address.invalid"));
        }

        let port = self.port.unwrap_or(22);
        if port == 0 {
            return Err(AppError::validation("host.port.invalid"));
        }

        let username = self.username.unwrap_or_default().trim().to_string();
        if username.chars().count() > 64 {
            return Err(AppError::validation("host.username.tooLong"));
        }

        let auth_method = self
            .auth_method
            .unwrap_or_else(|| "password".to_string())
            .trim()
            .to_string();
        if !AUTH_METHODS.contains(&auth_method.as_str()) {
            return Err(AppError::validation("host.authMethod.invalid"));
        }

        let color = match clean_optional(self.color, 7) {
            Some(value) if valid_color(&value) => Some(value),
            Some(_) => return Err(AppError::validation("host.color.invalid")),
            None => None,
        };

        let mut tags: Vec<String> = self
            .tags
            .into_iter()
            .map(|tag| tag.trim().to_string())
            .filter(|tag| !tag.is_empty() && tag.chars().count() <= 24)
            .take(12)
            .collect();
        tags.dedup();

        Ok(HostDraft {
            group_id: clean_optional(self.group_id, 64),
            name,
            host,
            port,
            username,
            auth_method,
            key_path: clean_optional(self.key_path, 1024),
            favorite: self.favorite,
            color,
            tags,
            note: clean_optional(self.note, 2000),
        })
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupInput {
    pub name: String,
    #[serde(default)]
    pub parent_id: Option<String>,
}

impl GroupInput {
    pub fn validate(self) -> AppResult<(String, Option<String>)> {
        let name = self.name.trim().to_string();
        if name.is_empty() {
            return Err(AppError::validation("group.name.required"));
        }
        if name.chars().count() > 60 {
            return Err(AppError::validation("group.name.tooLong"));
        }
        Ok((name, clean_optional(self.parent_id, 64)))
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TabRecord {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub host_id: Option<String>,
    #[serde(default)]
    pub sort_order: i64,
    #[serde(default)]
    pub pinned: bool,
    pub state: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn base() -> HostInput {
        HostInput {
            name: "  web  ".into(),
            group_id: None,
            host: "  example.com  ".into(),
            port: Some(2222),
            username: Some("  root  ".into()),
            auth_method: Some("key".into()),
            key_path: None,
            favorite: false,
            color: None,
            tags: Vec::new(),
            note: None,
        }
    }

    #[test]
    fn normalizes_whitespace_and_defaults() {
        let draft = base().validate().expect("valid host");
        assert_eq!(draft.name, "web");
        assert_eq!(draft.host, "example.com");
        assert_eq!(draft.username, "root");
        assert_eq!(draft.port, 2222);
        assert_eq!(draft.auth_method, "key");
    }

    #[test]
    fn falls_back_to_port_22() {
        let mut input = base();
        input.port = None;
        assert_eq!(input.validate().expect("valid").port, 22);
    }

    #[test]
    fn rejects_blank_fields() {
        let mut input = base();
        input.name = "   ".into();
        assert!(matches!(input.validate(), Err(AppError::Validation(_))));

        let mut input = base();
        input.host = String::new();
        assert!(matches!(input.validate(), Err(AppError::Validation(_))));
    }

    #[test]
    fn rejects_bad_addresses_and_auth() {
        let mut input = base();
        input.host = "bad host".into();
        assert!(input.validate().is_err());

        let mut input = base();
        input.auth_method = Some("magic".into());
        assert!(input.validate().is_err());

        let mut input = base();
        input.port = Some(0);
        assert!(input.validate().is_err());
    }

    #[test]
    fn validates_optional_color() {
        let mut input = base();
        input.color = Some("#35E0FF".into());
        assert_eq!(
            input.validate().expect("valid").color.as_deref(),
            Some("#35E0FF")
        );

        let mut input = base();
        input.color = Some("blue".into());
        assert!(input.validate().is_err());
    }

    #[test]
    fn trims_and_dedups_tags() {
        let mut input = base();
        input.tags = vec![" web ".into(), "web".into(), String::new(), "eu".into()];
        let draft = input.validate().expect("valid");
        assert_eq!(draft.tags, vec!["web".to_string(), "eu".to_string()]);
    }

    #[test]
    fn group_names_are_required() {
        let input = GroupInput {
            name: "  ".into(),
            parent_id: None,
        };
        assert!(input.validate().is_err());
    }
}
