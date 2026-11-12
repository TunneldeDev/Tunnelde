use std::io::Read;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

pub const API_VERSION: u32 = 1;
/// Required dependencies change admission semantics. Old v1-only hosts reject
/// these packages instead of silently ignoring their required dependencies.
pub const DEPENDENCY_API_VERSION: u32 = 2;
pub const MANIFEST_FILE: &str = "tunnelde-plugin.json";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginCommand {
    pub id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub frontend: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub keybindings: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mac_keybindings: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub editor: Option<EditorCommand>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_menu: Option<FileMenuCommand>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub host_menu: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditorCommand {
    pub extensions: Vec<String>,
    #[serde(default)]
    pub format: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileMenuCommand {
    pub sources: Vec<String>,
    pub kinds: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub extensions: Vec<String>,
}

fn valid_keybindings(bindings: &[String]) -> bool {
    bindings.len() <= 4
        && bindings.iter().all(|binding| {
            let parts: Vec<_> = binding.split('+').collect();
            let Some((key, modifiers)) = parts.split_last() else {
                return false;
            };
            let mut unique = std::collections::HashSet::new();
            let modifier_ok = modifiers.iter().all(|part| {
                matches!(*part, "Mod" | "Ctrl" | "Meta" | "Shift" | "Alt") && unique.insert(*part)
            });
            let exclusive = !((unique.contains("Mod")
                && (unique.contains("Ctrl") || unique.contains("Meta")))
                || (unique.contains("Ctrl") && unique.contains("Meta")));
            let key_ok = (key.len() == 1 && key.as_bytes()[0].is_ascii_alphanumeric())
                || key
                    .strip_prefix('F')
                    .and_then(|n| n.parse::<u8>().ok())
                    .is_some_and(|n| (1..=24).contains(&n))
                || matches!(
                    *key,
                    "Comma"
                        | "Period"
                        | "Backslash"
                        | "Equal"
                        | "Plus"
                        | "Minus"
                        | "Space"
                        | "Escape"
                        | "Tab"
                        | "Enter"
                        | "Backspace"
                        | "Delete"
                        | "Insert"
                        | "Home"
                        | "End"
                        | "PageUp"
                        | "PageDown"
                        | "ArrowUp"
                        | "ArrowDown"
                        | "ArrowLeft"
                        | "ArrowRight"
                );
            modifier_ok && exclusive && key_ok
        })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginView {
    pub id: String,
    pub title: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PluginTheme {
    pub id: String,
    pub name: String,
    pub appearance: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accent: Option<String>,
    pub colors: std::collections::BTreeMap<String, String>,
}

impl PluginTheme {
    fn valid(&self) -> bool {
        valid_id(&self.id)
            && !self.name.trim().is_empty()
            && self.name.len() <= 120
            && matches!(self.appearance.as_str(), "light" | "dark")
            && self.accent.as_deref().is_none_or(hex_color)
            && !self.colors.is_empty()
            && self.colors.iter().all(|(key, value)| {
                crate::settings::COLOR_REGIONS.contains(&key.as_str()) && hex_color(value)
            })
    }
}

fn hex_color(value: &str) -> bool {
    value.len() == 7
        && value.starts_with('#')
        && value.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginManifest {
    pub id: String,
    pub name: String,
    pub version: String,
    pub api_version: u32,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dependencies: Vec<super::PluginDependency>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_fields: Option<crate::services::host_fields::Schema>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub configuration:
        Option<crate::services::plugin_configuration::contracts::schema::Declaration>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_runner: Option<super::runners::bootstrap::contracts::Manifest>,
    #[serde(default)]
    pub main: String,
    /// `theme` packages contribute data without an executable entry point.
    #[serde(default)]
    pub runtime: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub commands: Vec<PluginCommand>,
    #[serde(default)]
    pub views: Vec<PluginView>,
    #[serde(default)]
    pub permissions: Vec<String>,
    #[serde(default)]
    pub author: Option<String>,
    #[serde(default)]
    pub readme: Option<String>,
    #[serde(default)]
    pub engines: std::collections::BTreeMap<String, String>,
    #[serde(default)]
    pub themes: Vec<PluginTheme>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub file_icon_themes: Vec<super::file_icons::FileIconTheme>,
    #[serde(default)]
    pub file_previews: Vec<crate::preview::providers::Provider>,
    #[serde(default)]
    pub mounted_file_reveal: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frontend: Option<super::frontend::FrontendManifest>,
}

pub(super) fn valid_tags(tags: &[String]) -> bool {
    let mut unique = std::collections::HashSet::new();
    tags.len() <= 24
        && tags.iter().all(|tag| {
            !tag.is_empty()
                && tag.len() <= 64
                && tag.trim() == tag
                && tag
                    .chars()
                    .all(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | '.'))
                && unique.insert(tag.to_lowercase())
        })
}

pub fn load(dir: &Path) -> AppResult<PluginManifest> {
    let path = dir.join(MANIFEST_FILE);
    let mut raw = String::new();
    std::fs::File::open(&path)
        .and_then(|file| file.take(1024 * 1024 + 1).read_to_string(&mut raw))
        .map_err(|error| AppError::Validation(format!("plugin.manifest.unreadable: {error}")))?;
    if raw.len() > 1024 * 1024 {
        return Err(AppError::validation("plugin.manifest.invalid"));
    }
    let manifest: PluginManifest = serde_json::from_str(&raw)
        .map_err(|error| AppError::Validation(format!("plugin.manifest.invalid: {error}")))?;
    manifest.validate(dir)?;
    Ok(manifest)
}

impl PluginManifest {
    fn validate(&self, dir: &Path) -> AppResult<()> {
        if !matches!(self.api_version, API_VERSION | DEPENDENCY_API_VERSION) {
            return Err(AppError::validation("plugin.apiVersion.unsupported"));
        }
        if !self.dependencies.is_empty()
            && (self.api_version != DEPENDENCY_API_VERSION
                || self.runtime.as_deref() == Some("theme"))
        {
            return Err(AppError::validation("plugin.activation.declarationVersion"));
        }
        super::runtime::activation::validate_dependencies(&self.id, &self.dependencies)?;
        if let Some(configuration) = &self.configuration {
            configuration.validate()?;
        }
        if let Some(schema) = &self.host_fields {
            schema.validate()?;
            if !self
                .permissions
                .iter()
                .any(|permission| permission == "hosts.read")
            {
                return Err(AppError::validation("hostFields.permissionRequired"));
            }
        }
        if let Some(frontend) = &self.frontend {
            frontend.validate(dir)?;
            if self.runtime.as_deref() == Some("theme")
                || !self.permissions.iter().any(|p| p == "ui.trusted")
            {
                return Err(AppError::validation("plugin.frontend.invalid"));
            }
        }
        if self.remote_runner.is_some()
            && (matches!(self.runtime.as_deref(), Some("theme" | "declarative"))
                || !self
                    .permissions
                    .iter()
                    .any(|permission| permission == "ssh.exec"))
        {
            return Err(AppError::validation("plugin.runners.invalidInitialization"));
        }
        if self.commands.iter().any(|command| command.frontend) && self.frontend.is_none() {
            return Err(AppError::validation("plugin.frontend.invalid"));
        }
        if self.mounted_file_reveal
            && (!self.permissions.iter().any(|p| p == "mounts.read")
                || !self.permissions.iter().any(|p| p == "mounts.write")
                || self.runtime.as_deref() == Some("theme"))
        {
            return Err(AppError::validation("plugin.command.invalid"));
        }
        if !crate::preview::providers::valid(&self.file_previews) {
            return Err(AppError::validation("preview.invalidProvider"));
        }
        if !super::file_icons::valid_themes(&self.file_icon_themes) {
            return Err(AppError::validation("plugin.fileIcons.invalid"));
        }
        if !valid_tags(&self.tags) {
            return Err(AppError::validation("plugin.tags.invalid"));
        }
        if !valid_id(&self.id) {
            return Err(AppError::validation("plugin.id.invalid"));
        }
        if self.name.trim().is_empty() {
            return Err(AppError::validation("plugin.name.required"));
        }
        if normalized_version(&self.version).is_none() {
            return Err(AppError::validation("plugin.version.invalid"));
        }
        let mut theme_ids = std::collections::HashSet::new();
        if self.themes.len() > 32
            || self
                .themes
                .iter()
                .any(|theme| !theme.valid() || !theme_ids.insert(&theme.id))
        {
            return Err(AppError::validation("plugin.theme.invalid"));
        }
        if self
            .engines
            .get("node")
            .is_some_and(|range| semver::VersionReq::parse(range).is_err())
        {
            return Err(AppError::validation("node.invalidRange"));
        }
        if self
            .engines
            .get("tunnelde")
            .is_some_and(|range| semver::VersionReq::parse(range).is_err())
        {
            return Err(AppError::validation("plugin.engine.invalidRange"));
        }
        let mut command_ids = std::collections::HashSet::new();
        if self
            .commands
            .iter()
            .filter(|command| command.host_menu)
            .count()
            > 16
        {
            return Err(AppError::validation("plugin.command.invalid"));
        }
        for command in &self.commands {
            if !valid_command_id(&command.id)
                || command.title.trim().is_empty()
                || !command_ids.insert(&command.id)
                || (command.host_menu
                    && (command.title.chars().count() > 120
                        || command.title.chars().any(char::is_control)
                        || command.editor.is_some()
                        || command.file_menu.is_some()
                        || !self
                            .permissions
                            .iter()
                            .any(|permission| permission == "hosts.read")))
                || !valid_keybindings(&command.keybindings)
                || command
                    .mac_keybindings
                    .as_ref()
                    .is_some_and(|keys| !valid_keybindings(keys))
                || command.file_menu.as_ref().is_some_and(|menu| {
                    menu.sources.is_empty()
                        || menu.sources.len() > 2
                        || menu
                            .sources
                            .iter()
                            .any(|source| !matches!(source.as_str(), "local" | "remote"))
                        || menu
                            .sources
                            .iter()
                            .collect::<std::collections::HashSet<_>>()
                            .len()
                            != menu.sources.len()
                        || menu.kinds.is_empty()
                        || menu.kinds.len() > 2
                        || menu
                            .kinds
                            .iter()
                            .any(|kind| !matches!(kind.as_str(), "file" | "directory"))
                        || menu
                            .kinds
                            .iter()
                            .collect::<std::collections::HashSet<_>>()
                            .len()
                            != menu.kinds.len()
                        || menu.extensions.len() > 64
                        || menu.extensions.iter().any(|ext| {
                            ext.is_empty()
                                || ext.len() > 64
                                || !ext.bytes().all(|c| {
                                    c.is_ascii_alphanumeric() || matches!(c, b'.' | b'-' | b'_')
                                })
                        })
                        || (menu.sources.iter().any(|source| source == "local")
                            && !self.permissions.iter().any(|p| p == "fs.read"))
                        || (menu.sources.iter().any(|source| source == "remote")
                            && !self.permissions.iter().any(|p| p == "sftp.read"))
                })
                || command.editor.as_ref().is_some_and(|editor| {
                    editor.extensions.is_empty()
                        || editor.extensions.len() > 64
                        || editor.extensions.iter().any(|ext| {
                            ext.is_empty()
                                || ext.len() > 64
                                || !ext.bytes().all(|c| {
                                    c.is_ascii_alphanumeric() || matches!(c, b'.' | b'-' | b'_')
                                })
                        })
                        || !self.permissions.iter().any(|p| p == "editor.read")
                        || !self.permissions.iter().any(|p| p == "editor.write")
                })
            {
                return Err(AppError::validation("plugin.command.invalid"));
            }
        }
        let mut view_ids = std::collections::HashSet::new();
        if self
            .views
            .iter()
            .filter(|view| view.provider.is_some())
            .count()
            > 8
        {
            return Err(AppError::validation("plugin.view.invalid"));
        }
        for view in &self.views {
            if !valid_id(&view.id)
                || view.title.trim().is_empty()
                || !view_ids.insert(&view.id)
                || view
                    .location
                    .as_deref()
                    .is_some_and(|v| !matches!(v, "sidebar" | "workspace"))
                || view
                    .kind
                    .as_deref()
                    .is_some_and(|v| !matches!(v, "chat" | "blocks" | "component"))
                || (view.kind.as_deref() == Some("component") && self.frontend.is_none())
                || view.provider.as_deref().is_some_and(|target| {
                    !matches!(
                        target,
                        "hostList"
                            | "workbench"
                            | "fileBrowser"
                            | "filePreview"
                            | "terminal"
                            | "history"
                            | "forwarding"
                            | "monitor"
                            | "backgroundTasks"
                            | "processes"
                            | "quickAccess"
                            | "preferences"
                    ) || view.kind.as_deref() != Some("component")
                        || view.location.is_some()
                        || view.title.chars().count() > 120
                        || view.title.chars().any(char::is_control)
                        || (target == "hostList"
                            && !self.permissions.iter().any(|p| p == "hosts.read"))
                        || (target == "fileBrowser"
                            && ["fs.read", "sftp.read", "workspace.write"]
                                .iter()
                                .any(|p| !self.permissions.iter().any(|v| v == p)))
                        || (target == "filePreview"
                            && (!self.permissions.iter().any(|p| p == "filePreview.read")
                                || !self
                                    .permissions
                                    .iter()
                                    .any(|p| p == "fs.read" || p == "sftp.read")))
                        || (target == "terminal"
                            && ["sessions.read", "ssh.exec"]
                                .iter()
                                .any(|p| !self.permissions.iter().any(|v| v == p)))
                        || (target == "preferences"
                            && !self.permissions.iter().any(|p| p == "settings.read"))
                        || (target == "backgroundTasks"
                            && !self.permissions.iter().any(|p| p == "backgroundTasks.read"))
                        || (matches!(target, "monitor" | "processes")
                            && ["sessions.read", "monitor.read"]
                                .iter()
                                .any(|p| !self.permissions.iter().any(|v| v == p)))
                        || (target == "forwarding"
                            && ["hosts.read", "forwards.read"]
                                .iter()
                                .any(|p| !self.permissions.iter().any(|v| v == p)))
                        || (target == "quickAccess"
                            && [
                                "hosts.read",
                                "sessions.read",
                                "fs.read",
                                "sftp.read",
                                "workspace.read",
                                "editor.read",
                            ]
                            .iter()
                            .any(|p| !self.permissions.iter().any(|v| v == p)))
                        || (target == "history"
                            && ["sessions.read", "history.read"]
                                .iter()
                                .any(|p| !self.permissions.iter().any(|v| v == p)))
                })
                || view.icon.as_deref().is_some_and(|v| {
                    !matches!(
                        v,
                        "bot"
                            | "message-square"
                            | "sparkles"
                            | "blocks"
                            | "network"
                            | "wrench"
                            | "message-circle"
                            | "plug"
                            | "terminal"
                            | "server"
                            | "folder"
                            | "shield"
                    )
                })
            {
                return Err(AppError::validation("plugin.view.invalid"));
            }
        }
        let mut permission_names = std::collections::HashSet::new();
        for permission in &self.permissions {
            if !super::security::PERMISSIONS.contains(&permission.as_str())
                || !permission_names.insert(permission)
            {
                return Err(AppError::validation("plugin.permission.unknown"));
            }
        }
        match self.runtime.as_deref() {
            None | Some("node") => {}
            Some("frontend") => {
                if self.frontend.is_none()
                    || !self.main.is_empty()
                    || self.engines.contains_key("node")
                    || self
                        .views
                        .iter()
                        .any(|view| view.kind.as_deref() != Some("component"))
                {
                    return Err(AppError::validation("plugin.frontend.invalid"));
                }
                return Ok(());
            }
            Some("declarative") => {
                if self.main.is_empty() || self.views.is_empty() || !self.commands.is_empty() {
                    return Err(AppError::validation("plugin.runtime.invalid"));
                }
                // Declarative plugins use a JSON view definition as their entry.
                entry_path(dir, &self.main)?;
                return Ok(());
            }
            Some("wasm") => {
                if !self.main.to_ascii_lowercase().ends_with(".wasm") {
                    return Err(AppError::validation("plugin.runtime.invalid"));
                }
            }
            Some("theme") => {
                if (self.themes.is_empty()
                    && self.file_icon_themes.is_empty()
                    && self.file_previews.is_empty())
                    || !self.main.is_empty()
                    || !self.commands.is_empty()
                    || !self.views.is_empty()
                    || !self.permissions.is_empty()
                {
                    return Err(AppError::validation("plugin.theme.invalid"));
                }
                return Ok(());
            }
            Some(_) => return Err(AppError::validation("plugin.runtime.invalid")),
        }
        entry_path(dir, &self.main)?;
        Ok(())
    }
}

/// Resolves the entry script and refuses anything outside the plugin folder.
pub fn entry_path(dir: &Path, main: &str) -> AppResult<PathBuf> {
    let root = dir
        .canonicalize()
        .map_err(|error| AppError::Validation(format!("plugin.path: {error}")))?;
    let entry = root.join(main);
    let entry = entry
        .canonicalize()
        .map_err(|error| AppError::Validation(format!("plugin.entry.missing: {error}")))?;
    if !entry.starts_with(&root) {
        return Err(AppError::validation("plugin.entry.outside"));
    }
    if !entry.is_file() {
        return Err(AppError::validation("plugin.entry.missing"));
    }
    Ok(entry)
}

pub fn read_readme(dir: &Path, name: &str) -> Option<String> {
    let path = entry_path(dir, name).ok()?;
    let mut text = String::new();
    std::fs::File::open(path)
        .ok()?
        .take(100 * 1024 + 1)
        .read_to_string(&mut text)
        .ok()?;
    (text.len() <= 100 * 1024).then_some(text)
}

pub fn normalized_version(value: &str) -> Option<semver::Version> {
    let normalized = if value.split('.').count() == 2 {
        format!("{value}.0")
    } else {
        value.into()
    };
    semver::Version::parse(&normalized).ok()
}

pub fn valid_id(value: &str) -> bool {
    let mut chars = value.chars();
    match chars.next() {
        Some(first) if first.is_ascii_lowercase() || first.is_ascii_digit() => {}
        _ => return false,
    }
    value.len() <= 64
        && chars.all(|character| {
            character.is_ascii_lowercase()
                || character.is_ascii_digit()
                || character == '-'
                || character == '_'
        })
}

pub fn valid_command_id(value: &str) -> bool {
    value.len() <= 128 && !value.is_empty() && value.split('.').all(valid_id)
}

#[cfg(test)]
mod tests {
    #[test]
    fn host_menu_requires_read_permission_and_one_bounded_context() {
        let dir = temp_dir("host-menu");
        std::fs::write(dir.join("index.js"), "").unwrap();
        let base = serde_json::json!({"id":"host-tool","name":"Host tool","version":"1.0.0",
            "apiVersion":1,"main":"index.js","permissions":["hosts.read"],
            "commands":[{"id":"inspect","title":"Inspect host","hostMenu":true}]});
        let save = |value: &serde_json::Value| {
            std::fs::write(dir.join(MANIFEST_FILE), serde_json::to_vec(value).unwrap()).unwrap();
            load(&dir)
        };
        let loaded = save(&base).unwrap();
        assert!(loaded.commands[0].host_menu);
        let mut legacy = base.clone();
        legacy["commands"][0]
            .as_object_mut()
            .unwrap()
            .remove("hostMenu");
        assert!(!save(&legacy).unwrap().commands[0].host_menu);
        assert!(serde_json::to_value(&save(&legacy).unwrap().commands[0])
            .unwrap()
            .get("hostMenu")
            .is_none());
        let mut invalid = base.clone();
        invalid["permissions"] = serde_json::json!([]);
        assert!(save(&invalid).is_err());
        for field in ["editor", "fileMenu"] {
            let mut invalid = base.clone();
            invalid["permissions"] =
                serde_json::json!(["hosts.read", "editor.read", "editor.write", "fs.read"]);
            invalid["commands"][0][field] = if field == "editor" {
                serde_json::json!({"extensions":["json"]})
            } else {
                serde_json::json!({"sources":["local"],"kinds":["file"]})
            };
            assert!(save(&invalid).is_err());
        }
        for title in ["x".repeat(121), "Inspect\nhost".to_owned()] {
            let mut invalid = base.clone();
            invalid["commands"][0]["title"] = title.into();
            assert!(save(&invalid).is_err());
        }
        let mut maximum = base.clone();
        maximum["commands"] = (0..16).map(|i| serde_json::json!({"id":format!("inspect-{i}"),"title":"Inspect","hostMenu":true})).collect();
        assert!(save(&maximum).is_ok());
        maximum["commands"]
            .as_array_mut()
            .unwrap()
            .push(serde_json::json!({"id":"overflow","title":"Overflow","hostMenu":true}));
        assert!(save(&maximum).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn frontend_entry_requires_explicit_trust_and_supports_pure_and_combined_runtimes() {
        let root = temp_dir("trusted-frontend");
        std::fs::create_dir(root.join("ui")).unwrap();
        std::fs::write(root.join("ui/index.mjs"), "export function activate(){}").unwrap();
        std::fs::write(root.join("backend.mjs"), "backend").unwrap();
        let mut value = serde_json::json!({"id":"custom-ui","name":"UI","version":"1.0.0","apiVersion":1,
            "runtime":"frontend","frontend":{"entry":"ui/index.mjs","sdk":"^0.1.0"},
            "permissions":["ui.trusted"],"commands":[{"id":"hello","title":"Hello","frontend":true}],
            "views":[{"id":"main","title":"Main","kind":"component"}]});
        let save = |value: &serde_json::Value| {
            std::fs::write(root.join(MANIFEST_FILE), serde_json::to_vec(value).unwrap()).unwrap();
            load(&root)
        };
        assert!(save(&value).is_ok());
        value["views"][0]["provider"] = "workbench".into();
        assert!(save(&value).is_ok());
        value["views"][0]["provider"] = "hostList".into();
        assert!(save(&value).is_err());
        value["permissions"] = serde_json::json!(["ui.trusted", "hosts.read"]);
        assert!(save(&value).is_ok());
        value["views"][0]["provider"] = "fileBrowser".into();
        assert!(save(&value).is_err());
        for omitted in ["fs.read", "sftp.read", "workspace.write"] {
            value["permissions"] =
                serde_json::json!(["ui.trusted", "fs.read", "sftp.read", "workspace.write"]
                    .into_iter()
                    .filter(|v| *v != omitted)
                    .collect::<Vec<_>>());
            assert!(save(&value).is_err());
        }
        value["permissions"] =
            serde_json::json!(["ui.trusted", "fs.read", "sftp.read", "workspace.write"]);
        assert!(save(&value).is_ok());
        value["views"][0]["provider"] = "filePreview".into();
        for permissions in [
            serde_json::json!(["ui.trusted", "filePreview.read"]),
            serde_json::json!(["ui.trusted", "fs.read"]),
            serde_json::json!(["filePreview.read", "fs.read"]),
        ] {
            value["permissions"] = permissions;
            assert!(save(&value).is_err());
        }
        for endpoint in ["fs.read", "sftp.read"] {
            value["permissions"] = serde_json::json!(["ui.trusted", "filePreview.read", endpoint]);
            assert!(save(&value).is_ok());
        }
        value["views"][0]["provider"] = "terminal".into();
        for omitted in ["ui.trusted", "sessions.read", "ssh.exec"] {
            value["permissions"] = serde_json::json!(["ui.trusted", "sessions.read", "ssh.exec"]
                .into_iter()
                .filter(|v| *v != omitted)
                .collect::<Vec<_>>());
            assert!(save(&value).is_err());
        }
        value["permissions"] = serde_json::json!(["ui.trusted", "sessions.read", "ssh.exec"]);
        assert!(save(&value).is_ok());
        value["views"][0]["provider"] = "history".into();
        for omitted in ["ui.trusted", "sessions.read", "history.read"] {
            value["permissions"] =
                serde_json::json!(["ui.trusted", "sessions.read", "history.read"]
                    .into_iter()
                    .filter(|v| *v != omitted)
                    .collect::<Vec<_>>());
            assert!(save(&value).is_err());
        }
        value["permissions"] = serde_json::json!(["ui.trusted", "sessions.read", "history.read"]);
        assert!(save(&value).is_ok());
        value["views"][0]["provider"] = "monitor".into();
        for omitted in ["ui.trusted", "sessions.read", "monitor.read"] {
            value["permissions"] =
                serde_json::json!(["ui.trusted", "sessions.read", "monitor.read"]
                    .into_iter()
                    .filter(|v| *v != omitted)
                    .collect::<Vec<_>>());
            assert!(save(&value).is_err());
        }
        value["permissions"] = serde_json::json!(["ui.trusted", "sessions.read", "monitor.read"]);
        assert!(save(&value).is_ok());
        value["views"][0]["provider"] = "processes".into();
        for omitted in ["ui.trusted", "sessions.read", "monitor.read"] {
            value["permissions"] =
                serde_json::json!(["ui.trusted", "sessions.read", "monitor.read"]
                    .into_iter()
                    .filter(|v| *v != omitted)
                    .collect::<Vec<_>>());
            assert!(save(&value).is_err());
        }
        value["permissions"] = serde_json::json!(["ui.trusted", "sessions.read", "monitor.read"]);
        assert!(save(&value).is_ok());
        value["views"][0]["provider"] = "backgroundTasks".into();
        for omitted in ["ui.trusted", "backgroundTasks.read"] {
            value["permissions"] = serde_json::json!(["ui.trusted", "backgroundTasks.read"]
                .into_iter()
                .filter(|v| *v != omitted)
                .collect::<Vec<_>>());
            assert!(save(&value).is_err());
        }
        value["permissions"] = serde_json::json!(["ui.trusted", "backgroundTasks.read"]);
        assert!(save(&value).is_ok());
        value["views"][0]["provider"] = "forwarding".into();
        value["views"][0]["provider"] = "preferences".into();
        for omitted in ["ui.trusted", "settings.read"] {
            value["permissions"] = serde_json::json!(["ui.trusted", "settings.read"]
                .into_iter()
                .filter(|p| *p != omitted)
                .collect::<Vec<_>>());
            assert!(save(&value).is_err());
        }
        value["permissions"] = serde_json::json!(["ui.trusted", "settings.read"]);
        assert!(save(&value).is_ok());
        value["permissions"] = serde_json::json!(["ui.trusted", "settings.read", "settings.write"]);
        assert!(save(&value).is_ok());
        let search_permissions = [
            "ui.trusted",
            "hosts.read",
            "sessions.read",
            "fs.read",
            "sftp.read",
            "workspace.read",
            "editor.read",
        ];
        value["views"][0]["provider"] = "quickAccess".into();
        value["permissions"] = serde_json::json!(search_permissions);
        assert!(save(&value).is_ok());
        for omitted in search_permissions {
            value["permissions"] = serde_json::json!(search_permissions
                .into_iter()
                .filter(|p| *p != omitted)
                .collect::<Vec<_>>());
            assert!(save(&value).is_err());
        }
        value["views"][0]["provider"] = "forwarding".into();
        for omitted in ["ui.trusted", "hosts.read", "forwards.read"] {
            value["permissions"] = serde_json::json!(["ui.trusted", "hosts.read", "forwards.read"]
                .into_iter()
                .filter(|v| *v != omitted)
                .collect::<Vec<_>>());
            assert!(save(&value).is_err());
        }
        value["permissions"] = serde_json::json!(["ui.trusted", "hosts.read", "forwards.read"]);
        assert!(save(&value).is_ok());
        value["views"][0]["location"] = "sidebar".into();
        assert!(save(&value).is_err());
        value["views"][0]
            .as_object_mut()
            .unwrap()
            .remove("location");
        value["views"][0]["provider"] = "unknown".into();
        assert!(save(&value).is_err());
        value["views"][0]
            .as_object_mut()
            .unwrap()
            .remove("provider");
        value["permissions"] = serde_json::json!([]);
        assert!(save(&value).is_err());
        value["permissions"] = serde_json::json!(["ui.trusted"]);
        value["runtime"] = "node".into();
        value["main"] = "backend.mjs".into();
        assert!(save(&value).is_ok());
        for entry in [
            "../ui/index.mjs",
            "ui/../backend.mjs",
            "ui//index.mjs",
            "ui/index.mjs?x",
            "ui/./index.mjs",
        ] {
            value["frontend"]["entry"] = entry.into();
            assert!(save(&value).is_err(), "{entry}");
        }
        value["frontend"]["entry"] = "ui/index.mjs".into();
        value["frontend"]["sdk"] = "not a range".into();
        assert!(save(&value).is_err());
        value["frontend"]["sdk"] = "^2.0.0".into();
        let manifest = save(&value).unwrap();
        assert!(manifest.frontend.unwrap().require_sdk().is_err());
        std::fs::remove_dir_all(root).unwrap();
    }
    use super::*;

    #[test]
    fn editor_commands_require_permissions_and_validate_shortcuts() {
        let dir = temp_dir("editor-commands");
        std::fs::write(dir.join("index.js"), "").unwrap();
        let base = serde_json::json!({"id":"formatter","name":"Formatter","version":"1.0.0",
            "apiVersion":1,"main":"index.js","permissions":["editor.read","editor.write"],
            "commands":[{"id":"format","title":"Format document","keybindings":["Mod+Alt+J"],
            "macKeybindings":["Meta+Shift+J"],"editor":{"extensions":["json","config.json"],"format":true}}]});
        std::fs::write(dir.join(MANIFEST_FILE), serde_json::to_vec(&base).unwrap()).unwrap();
        let loaded = load(&dir).unwrap();
        assert!(loaded.commands[0].editor.as_ref().unwrap().format);
        assert_eq!(loaded.commands[0].keybindings, ["Mod+Alt+J"]);
        let mut cases = Vec::new();
        for permissions in [
            serde_json::json!([]),
            serde_json::json!(["editor.read"]),
            serde_json::json!(["editor.write"]),
        ] {
            let mut value = base.clone();
            value["permissions"] = permissions;
            cases.push(value);
        }
        for keys in [
            serde_json::json!(["Mod+Ctrl+F"]),
            serde_json::json!(["Ctrl+Meta+F"]),
            serde_json::json!(["Ctrl+Ctrl+F"]),
            serde_json::json!(["Mod+F25"]),
            serde_json::json!([""]),
            serde_json::json!(["Mod+A", "Mod+B", "Mod+C", "Mod+D", "Mod+E"]),
        ] {
            let mut value = base.clone();
            value["commands"][0]["keybindings"] = keys;
            cases.push(value);
        }
        for extensions in [
            serde_json::json!([]),
            serde_json::json!(["../json"]),
            serde_json::json!([""]),
            serde_json::json!(["json/"]),
            serde_json::json!(["x".repeat(65)]),
        ] {
            let mut value = base.clone();
            value["commands"][0]["editor"]["extensions"] = extensions;
            cases.push(value);
        }
        for value in cases {
            std::fs::write(dir.join(MANIFEST_FILE), serde_json::to_vec(&value).unwrap()).unwrap();
            assert!(load(&dir).is_err(), "{value}");
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn file_menu_requires_scoped_permissions_and_valid_filters() {
        let dir = temp_dir("file-menu");
        std::fs::write(dir.join("index.js"), "").unwrap();
        let base = serde_json::json!({"id":"file-tool","name":"File tool","version":"1.0.0", "apiVersion":1,
            "main":"index.js","permissions":["fs.read","sftp.read"],
            "commands":[{"id":"open","title":"Open","fileMenu":{"sources":["local","remote"],"kinds":["file","directory"],"extensions":["json"]}}]});
        std::fs::write(dir.join(MANIFEST_FILE), serde_json::to_vec(&base).unwrap()).unwrap();
        assert!(load(&dir).unwrap().commands[0].file_menu.is_some());
        for (field, value) in [
            ("sources", serde_json::json!([])),
            ("sources", serde_json::json!(["remote", "remote"])),
            ("sources", serde_json::json!(["other"])),
            ("kinds", serde_json::json!(["symlink"])),
            ("extensions", serde_json::json!(["../json"])),
        ] {
            let mut invalid = base.clone();
            invalid["commands"][0]["fileMenu"][field] = value;
            std::fs::write(
                dir.join(MANIFEST_FILE),
                serde_json::to_vec(&invalid).unwrap(),
            )
            .unwrap();
            assert!(load(&dir).is_err(), "{invalid}");
        }
        let mut invalid = base.clone();
        invalid["permissions"] = serde_json::json!(["fs.read"]);
        std::fs::write(
            dir.join(MANIFEST_FILE),
            serde_json::to_vec(&invalid).unwrap(),
        )
        .unwrap();
        assert!(load(&dir).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn mounted_file_reveal_requires_explicit_mount_permissions() {
        let dir = temp_dir("mounted-reveal");
        std::fs::write(dir.join("views.json"), "{}").unwrap();
        let base = serde_json::json!({"id":"mount-tool","name":"Mount tool","version":"1.0.0","apiVersion":1,
            "runtime":"declarative","main":"views.json","views":[{"id":"main","title":"Mounts"}],
            "permissions":["mounts.read","mounts.write"],"mountedFileReveal":true});
        std::fs::write(dir.join(MANIFEST_FILE), serde_json::to_vec(&base).unwrap()).unwrap();
        assert!(load(&dir).unwrap().mounted_file_reveal);
        for permissions in [
            serde_json::json!([]),
            serde_json::json!(["mounts.read"]),
            serde_json::json!(["mounts.write"]),
        ] {
            let mut invalid = base.clone();
            invalid["permissions"] = permissions;
            std::fs::write(
                dir.join(MANIFEST_FILE),
                serde_json::to_vec(&invalid).unwrap(),
            )
            .unwrap();
            assert!(load(&dir).is_err());
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn tags_are_optional_bounded_distinct_and_support_unicode() {
        assert!(valid_tags(&[]));
        assert!(valid_tags(&["preview".into(), "文件".into()]));
        for tags in [
            vec!["PDF".into(), "pdf".into()],
            vec!["".into()],
            vec!["a b".into()],
            vec![" tag".into()],
            vec!["a".repeat(65)],
            vec!["tag".into(); 25],
        ] {
            assert!(!valid_tags(&tags));
        }
    }

    fn write(dir: &Path, main: &str) -> PluginManifest {
        let payload = format!(
            r#"{{"id":"hello","name":"Hello","version":"0.1.0","apiVersion":1,"main":"{main}"}}"#
        );
        std::fs::write(dir.join(MANIFEST_FILE), payload).expect("manifest");
        load(dir).expect("valid manifest")
    }

    #[test]
    fn initialized_remote_runner_requires_a_typed_executable_opt_in() {
        let dir = temp_dir("remote-runner");
        std::fs::write(dir.join("main.js"), "").unwrap();
        let valid = serde_json::json!({"id":"remote","name":"Remote","version":"1.0.0","apiVersion":1,
            "main":"main.js","permissions":["ssh.exec"],"remoteRunner":{"configuration":"initialize-v1"}});
        std::fs::write(dir.join(MANIFEST_FILE), serde_json::to_vec(&valid).unwrap()).unwrap();
        assert!(load(&dir).unwrap().remote_runner.is_some());
        for (field, value) in [
            ("permissions", serde_json::json!([])),
            ("runtime", serde_json::json!("theme")),
            ("remoteRunner", serde_json::json!({"configuration":"file"})),
            (
                "remoteRunner",
                serde_json::json!({"configuration":"initialize-v1","fallback":true}),
            ),
        ] {
            let mut bad = valid.clone();
            bad[field] = value;
            std::fs::write(dir.join(MANIFEST_FILE), serde_json::to_vec(&bad).unwrap()).unwrap();
            assert!(load(&dir).is_err());
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("tunnelde-plugin-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    #[test]
    fn host_fields_require_read_permission_and_validate_the_entire_schema() {
        let dir = temp_dir("host-fields");
        std::fs::write(dir.join("main.js"), "").unwrap();
        let valid = serde_json::json!({"id":"metadata","name":"Metadata","version":"1.0.0","apiVersion":1,"main":"main.js","permissions":["hosts.read"],"hostFields":{"version":1,"fields":[{"id":"owner","label":"Owner","type":"text"}]}});
        std::fs::write(dir.join(MANIFEST_FILE), serde_json::to_vec(&valid).unwrap()).unwrap();
        assert!(load(&dir).unwrap().host_fields.is_some());
        let mut bad = valid.clone();
        bad["permissions"] = serde_json::json!([]);
        std::fs::write(dir.join(MANIFEST_FILE), serde_json::to_vec(&bad).unwrap()).unwrap();
        assert!(load(&dir)
            .unwrap_err()
            .to_string()
            .contains("permissionRequired"));
        let mut bad = valid;
        bad["hostFields"]["fields"][0]["secret"] = true.into();
        std::fs::write(dir.join(MANIFEST_FILE), serde_json::to_vec(&bad).unwrap()).unwrap();
        assert!(load(&dir).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }

    fn theme_manifest() -> serde_json::Value {
        serde_json::json!({"id":"theme-pack", "name":"Theme pack", "version":"1.0.0", "apiVersion":1,
            "runtime":"theme", "themes":[{"id":"midnight", "name":"Midnight", "appearance":"dark",
                "accent":"#AABBCC", "colors":{"background":"#101214", "terminalForeground":"#eeeeee"}}]})
    }

    #[test]
    fn pure_theme_package_needs_no_executable_and_supports_many_themes() {
        let dir = temp_dir("theme-many");
        let mut data = theme_manifest();
        let mut themes = Vec::new();
        for index in 0..32 {
            let mut theme = data["themes"][0].clone();
            theme["id"] = format!("theme-{index}").into();
            theme["appearance"] = if index % 2 == 0 { "dark" } else { "light" }.into();
            themes.push(theme);
        }
        data["themes"] = themes.into();
        std::fs::write(dir.join(MANIFEST_FILE), serde_json::to_vec(&data).unwrap()).unwrap();
        let loaded = load(&dir).unwrap();
        assert!(loaded.main.is_empty());
        assert_eq!(loaded.themes.len(), 32);
        assert!(loaded.commands.is_empty());
        assert_eq!(loaded.themes[0].accent.as_deref(), Some("#AABBCC"));
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn pure_icon_packages_need_no_executable_permissions_or_color_palettes() {
        let dir = temp_dir("file-icons");
        let mut data = serde_json::json!({"id":"file-icons", "name":"File icons", "version":"1.0.0", "apiVersion":1,
            "runtime":"theme", "fileIconThemes":[{"id":"common", "name":"Common files",
                "icons":{"ts":{"symbol":"code", "color":"#3178C6", "label":"TS"}},
                "extensions":{"ts":"ts"}, "fileNames":{}}]});
        std::fs::write(dir.join(MANIFEST_FILE), serde_json::to_vec(&data).unwrap()).unwrap();
        let loaded = load(&dir).unwrap();
        assert_eq!(loaded.file_icon_themes.len(), 1);
        assert!(loaded.main.is_empty());
        assert!(loaded.themes.is_empty());
        data["permissions"] = serde_json::json!(["fs.read"]);
        std::fs::write(dir.join(MANIFEST_FILE), serde_json::to_vec(&data).unwrap()).unwrap();
        assert!(load(&dir).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn rejects_invalid_theme_colors_ids_names_appearances_and_pack_shapes() {
        let dir = temp_dir("theme-invalid");
        let base = theme_manifest();
        let mut cases = Vec::new();
        for (field, value) in [
            ("id", serde_json::json!("../escape")),
            ("name", serde_json::json!(" ")),
            ("name", serde_json::json!("x".repeat(121))),
            ("appearance", serde_json::json!("system")),
            ("accent", serde_json::json!("blue")),
            ("accent", serde_json::json!("#abc")),
            ("colors", serde_json::json!({})),
            ("colors", serde_json::json!({"unknown":"#123456"})),
            ("colors", serde_json::json!({"background":"red"})),
            ("colors", serde_json::json!({"background":"#12345g"})),
            ("colors", serde_json::json!({"background":"#12345678"})),
            ("colors", serde_json::json!({"background":"url(external)"})),
        ] {
            let mut data = base.clone();
            data["themes"][0][field] = value;
            cases.push(data);
        }
        let mut duplicate = base.clone();
        duplicate["themes"]
            .as_array_mut()
            .unwrap()
            .push(base["themes"][0].clone());
        cases.push(duplicate);
        let mut too_many = base.clone();
        too_many["themes"] = vec![base["themes"][0].clone(); 33].into();
        cases.push(too_many);
        for (field, value) in [
            ("themes", serde_json::json!([])),
            ("main", serde_json::json!("index.js")),
            ("commands", serde_json::json!([{"id":"run", "title":"Run"}])),
            (
                "views",
                serde_json::json!([{"id":"panel", "title":"Panel"}]),
            ),
            ("permissions", serde_json::json!(["log"])),
        ] {
            let mut data = base.clone();
            data[field] = value;
            cases.push(data);
        }
        for data in cases {
            std::fs::write(dir.join(MANIFEST_FILE), serde_json::to_vec(&data).unwrap()).unwrap();
            assert!(load(&dir).is_err(), "{data}");
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn executable_plugins_can_add_themes_but_still_require_their_entry() {
        let dir = temp_dir("theme-executable");
        for (runtime, main) in [("node", "index.js"), ("wasm", "plugin.wasm")] {
            let mut data = theme_manifest();
            data["runtime"] = runtime.into();
            data["main"] = main.into();
            std::fs::write(dir.join(MANIFEST_FILE), serde_json::to_vec(&data).unwrap()).unwrap();
            assert!(load(&dir).is_err());
            std::fs::write(dir.join(main), "").unwrap();
            assert_eq!(load(&dir).unwrap().themes.len(), 1);
            std::fs::remove_file(dir.join(main)).unwrap();
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn accepts_a_minimal_manifest() {
        let dir = temp_dir("minimal");
        std::fs::write(dir.join("index.js"), "").expect("entry");
        let manifest = write(&dir, "index.js");
        assert_eq!(manifest.id, "hello");
        assert_eq!(manifest.api_version, 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn validates_view_declarations() {
        let dir = temp_dir("views");
        std::fs::write(dir.join("index.js"), "").expect("entry");

        let payload = r#"{"id":"hello","name":"Hello","version":"0.1.0","apiVersion":1,"main":"index.js","views":[{"id":"panel","title":"Panel"}]}"#;
        std::fs::write(dir.join(MANIFEST_FILE), payload).expect("manifest");
        assert_eq!(load(&dir).expect("views").views.len(), 1);

        let duplicate = r#"{"id":"hello","name":"Hello","version":"0.1.0","apiVersion":1,"main":"index.js","views":[{"id":"panel","title":"A"},{"id":"panel","title":"B"}]}"#;
        std::fs::write(dir.join(MANIFEST_FILE), duplicate).expect("manifest");
        assert!(load(&dir).is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }
    #[test]
    fn rejects_missing_entry() {
        let dir = temp_dir("missing");
        let payload =
            r#"{"id":"hello","name":"Hello","version":"0.1.0","apiVersion":1,"main":"missing.js"}"#;
        std::fs::write(dir.join(MANIFEST_FILE), payload).expect("manifest");
        assert!(load(&dir).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn readme_is_bounded_text_inside_package_and_main_must_be_a_file() {
        let dir = temp_dir("readme");
        std::fs::write(dir.join("README.md"), "# Plugin\nUseful documentation").unwrap();
        assert_eq!(
            read_readme(&dir, "README.md").as_deref(),
            Some("# Plugin\nUseful documentation")
        );
        assert!(read_readme(&dir, "https://example.org/readme").is_none());
        let outside = dir.with_extension("md");
        std::fs::write(&outside, "outside").unwrap();
        assert!(read_readme(&dir, outside.to_str().unwrap()).is_none());
        std::fs::write(dir.join("huge.md"), vec![b'x'; 100 * 1024 + 1]).unwrap();
        assert!(read_readme(&dir, "huge.md").is_none());
        std::fs::create_dir(dir.join("folder")).unwrap();
        assert!(entry_path(&dir, "folder").is_err());
        std::fs::remove_file(outside).unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn rejects_escaping_entry() {
        let dir = temp_dir("escape");
        let payload =
            r#"{"id":"hello","name":"Hello","version":"0.1.0","apiVersion":1,"main":"../evil.js"}"#;
        std::fs::write(dir.join(MANIFEST_FILE), payload).expect("manifest");
        assert!(load(&dir).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_bad_ids_and_permissions() {
        let dir = temp_dir("ids");
        std::fs::write(dir.join("index.js"), "").expect("entry");
        let payload = r#"{"id":"Bad Id","name":"x","version":"1.0.0","apiVersion":1,"main":"index.js","permissions":["shell"]}"#;
        std::fs::write(dir.join(MANIFEST_FILE), payload).expect("manifest");
        assert!(load(&dir).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn validates_the_runtime_field() {
        let dir = temp_dir("runtime");
        std::fs::write(dir.join("plugin.wasm"), "").expect("wasm entry");
        std::fs::write(dir.join("index.js"), "").expect("node entry");

        let wasm = r#"{"id":"hello","name":"Hello","version":"0.1.0","apiVersion":1,"main":"plugin.wasm","runtime":"wasm"}"#;
        std::fs::write(dir.join(MANIFEST_FILE), wasm).expect("manifest");
        assert_eq!(
            load(&dir).expect("wasm runtime").runtime.as_deref(),
            Some("wasm")
        );

        let wrong_extension = r#"{"id":"hello","name":"Hello","version":"0.1.0","apiVersion":1,"main":"index.js","runtime":"wasm"}"#;
        std::fs::write(dir.join(MANIFEST_FILE), wrong_extension).expect("manifest");
        assert!(load(&dir).is_err());

        let unknown = r#"{"id":"hello","name":"Hello","version":"0.1.0","apiVersion":1,"main":"index.js","runtime":"python"}"#;
        std::fs::write(dir.join(MANIFEST_FILE), unknown).expect("manifest");
        assert!(load(&dir).is_err());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn declarative_plugins_require_local_data_and_expose_no_executable_commands() {
        let dir = temp_dir("declarative");
        std::fs::write(
            dir.join("views.json"),
            r#"{"views":{"main":{"blocks":[{"type":"mounts"}]}}}"#,
        )
        .unwrap();
        let manifest = serde_json::json!({"id":"sshfs-lite", "name":"SSHFS Lite", "version":"1.0.0", "apiVersion":1, "runtime":"declarative", "main":"views.json", "permissions":["mounts.read","mounts.write"], "views":[{"id":"main","title":"SSHFS"}]});
        std::fs::write(dir.join(MANIFEST_FILE), manifest.to_string()).unwrap();
        assert_eq!(load(&dir).unwrap().runtime.as_deref(), Some("declarative"));
        let mut invalid = manifest;
        invalid["commands"] = serde_json::json!([{"id":"exec","title":"Execute"}]);
        std::fs::write(dir.join(MANIFEST_FILE), invalid.to_string()).unwrap();
        assert!(load(&dir).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
