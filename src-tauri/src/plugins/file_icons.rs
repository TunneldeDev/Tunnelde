use std::collections::{BTreeMap, HashSet};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileIcon {
    pub symbol: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileIconTheme {
    pub id: String,
    pub name: String,
    pub icons: BTreeMap<String, FileIcon>,
    #[serde(default)]
    pub extensions: BTreeMap<String, String>,
    #[serde(default)]
    pub file_names: BTreeMap<String, String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_icon: Option<String>,
}

const SYMBOLS: &[&str] = &[
    "file",
    "code",
    "json",
    "text",
    "image",
    "audio",
    "video",
    "archive",
    "pdf",
    "spreadsheet",
    "terminal",
    "settings",
    "key",
    "database",
    "font",
    "binary",
    "markdown",
];

fn safe_name(value: &str, limit: usize) -> bool {
    !value.is_empty()
        && value.len() <= limit
        && value.trim() == value
        && !value
            .chars()
            .any(|c| c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?'))
}

pub fn valid_themes(themes: &[FileIconTheme]) -> bool {
    let mut theme_ids = HashSet::new();
    themes.len() <= 16
        && themes.iter().all(|theme| {
            let mut extensions = HashSet::new();
            let mut names = HashSet::new();
            super::manifest::valid_id(&theme.id)
                && theme_ids.insert(&theme.id)
                && safe_name(&theme.name, 120)
                && !theme.icons.is_empty()
                && theme.icons.len() <= 256
                && theme.icons.iter().all(|(id, icon)| {
                    super::manifest::valid_id(id)
                        && SYMBOLS.contains(&icon.symbol.as_str())
                        && icon.color.as_deref().is_none_or(|color| {
                            color.len() == 7
                                && color.starts_with('#')
                                && color.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit)
                        })
                        && icon.label.as_deref().is_none_or(|label| {
                            !label.is_empty()
                                && label.len() <= 4
                                && label.bytes().all(|c| c.is_ascii_alphanumeric())
                        })
                })
                && theme.extensions.len() <= 512
                && theme.extensions.iter().all(|(extension, icon)| {
                    safe_name(extension, 64)
                        && !extension.starts_with('.')
                        && !extension.ends_with('.')
                        && extensions.insert(extension.to_lowercase())
                        && theme.icons.contains_key(icon)
                })
                && theme.file_names.len() <= 128
                && theme.file_names.iter().all(|(name, icon)| {
                    safe_name(name, 255)
                        && names.insert(name.to_lowercase())
                        && theme.icons.contains_key(icon)
                })
                && theme
                    .default_icon
                    .as_ref()
                    .is_none_or(|icon| theme.icons.contains_key(icon))
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn theme() -> Value {
        json!({"id":"common", "name":"Common files", "icons": {
            "code":{"symbol":"code", "color":"#3178C6", "label":"TS"},
            "archive":{"symbol":"archive"}},
            "extensions":{"ts":"code", "tar.gz":"archive"},
            "fileNames":{"Dockerfile":"code", ".gitignore":"code"}})
    }
    fn valid(value: Value) -> bool {
        serde_json::from_value::<Vec<FileIconTheme>>(value)
            .is_ok_and(|themes| valid_themes(&themes))
    }
    #[test]
    fn validates_bounded_declarative_file_icons_and_compound_extensions() {
        assert!(valid(json!([theme()])));
        for value in [
            json!({"symbol":"image", "color":"url(https://example.com)"}),
            json!({"symbol":"script"}),
            json!({"symbol":"code", "label":"<svg>"}),
            json!({"symbol":"code", "url":"https://example.com/icon.svg"}),
        ] {
            let mut bad = theme();
            bad["icons"]["code"] = value;
            assert!(!valid(json!([bad])));
        }
    }
    #[test]
    fn rejects_unknown_references_duplicates_and_unbounded_maps() {
        for (field, value) in [
            ("extensions", json!({"ts":"missing"})),
            ("extensions", json!({"TS":"code", "ts":"code"})),
            ("extensions", json!({"../ts":"code"})),
            ("fileNames", json!({"../../passwd":"code"})),
            ("defaultIcon", json!("missing")),
        ] {
            let mut bad = theme();
            bad[field] = value;
            assert!(!valid(json!([bad])));
        }
        assert!(!valid(json!([theme(), theme()])));
        let mut bad = theme();
        bad["extensions"] = Value::Object(
            (0..513)
                .map(|n| (format!("ext{n}"), json!("code")))
                .collect(),
        );
        assert!(!valid(json!([bad])));
    }
}
