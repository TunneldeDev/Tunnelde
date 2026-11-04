use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

pub const LANGUAGES: [&str; 3] = ["system", "zh-CN", "en-US"];
pub const THEMES: [&str; 3] = ["dark", "light", "system"];
pub const ACCENTS: [&str; 5] = ["blue", "cyan", "green", "orange", "violet"];
pub const DENSITIES: [&str; 2] = ["comfortable", "compact"];
pub const MONO_FONTS: [&str; 4] = ["fira-code", "jetbrains-mono", "plex-mono", "system"];
pub const TITLE_BAR_STYLES: [&str; 2] = ["system", "compact"];
pub const MONITOR_INTERVALS: [u32; 6] = [1000, 2000, 3000, 5000, 10000, 30000];
pub const COLOR_REGIONS: [&str; 11] = [
    "background",
    "activityBar",
    "sidebar",
    "titleBar",
    "tabBar",
    "editor",
    "panel",
    "statusBar",
    "terminalBackground",
    "terminalForeground",
    "terminalCursor",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub network: crate::network::NetworkSettings,
    pub keyboard_shortcuts: BTreeMap<String, Vec<String>>,
    /// "system" | "zh-CN" | "en-US"
    pub language: String,
    /// "dark" | "light" | "system"
    pub theme: String,
    /// Preset id from [`ACCENTS`] or an opaque six-digit HEX color.
    pub accent: String,
    pub colors: BTreeMap<String, String>,
    /// "comfortable" | "compact"
    pub density: String,
    pub ui_font_size: u16,
    pub mono_font_size: u16,
    /// Font stack id from [`MONO_FONTS`].
    pub mono_font: String,
    pub sidebar_width: u16,
    pub right_panel: bool,
    pub right_panel_width: u16,
    pub user_css: String,
    pub auto_check_updates: bool,
    pub update_channel: String,
    pub update_source: String,
    pub update_source_url: String,
    pub update_check_interval: String,
    pub skipped_version: Option<String>,
    pub last_update_check: Option<i64>,
    pub close_to_tray: bool,
    /// Destroy the hidden WebView after a successful in-memory checkpoint.
    pub release_webview_in_tray: bool,
    /// Prefer the CPU terminal renderer and avoid speculative file preloading.
    pub lightweight_mode: bool,
    /// macOS: keep the Dock icon after closing the main window.
    pub show_dock_icon_in_background: bool,
    /// "system" uses native chrome; "compact" integrates the window controls.
    pub title_bar_style: String,
    pub record_terminal_history: bool,
    /// Warm the parent and neighbouring folders of an open file panel.
    pub preload_dirs: bool,
    /// How many child folders to warm per listing.
    pub preload_count: u16,
    pub motion: String,
    pub show_status_bar: bool,
    pub restore_workspace: bool,
    pub host_activation: String,
    pub host_direct_connect: bool,
    pub terminal_scrollback: u32,
    pub terminal_line_height: f64,
    pub terminal_cursor_style: String,
    pub terminal_cursor_blink: bool,
    pub terminal_inactive_cursor_style: String,
    pub terminal_scroll_sensitivity: u16,
    pub terminal_smooth_scrolling: bool,
    pub terminal_scroll_on_input: bool,
    pub terminal_copy_on_select: bool,
    pub terminal_right_click: String,
    pub terminal_renderer: String,
    pub file_icon_theme: String,
    pub files_show_hidden: bool,
    pub files_folders_first: bool,
    pub files_sort_by: String,
    pub files_sort_direction: String,
    pub transfer_optimization: bool,
    pub transfer_compression: bool,
    /// Zero chooses concurrency and block size automatically.
    pub transfer_concurrency: u16,
    pub transfer_chunk_kib: u32,
    pub transfer_requests: u16,
    /// KiB/s shared across tasks; zero is unlimited.
    pub transfer_upload_limit_kib: u32,
    pub transfer_download_limit_kib: u32,
    pub editor_word_wrap: bool,
    pub editor_tab_size: u16,
    pub editor_spell_check: bool,
    pub monitor_interval_ms: u32,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            network: crate::network::NetworkSettings::default(),
            keyboard_shortcuts: BTreeMap::new(),
            language: "system".into(),
            theme: "system".into(),
            accent: "blue".into(),
            colors: BTreeMap::new(),
            density: "comfortable".into(),
            ui_font_size: 13,
            mono_font_size: 14,
            mono_font: "fira-code".into(),
            sidebar_width: 272,
            right_panel: false,
            right_panel_width: 296,
            user_css: String::new(),
            auto_check_updates: true,
            update_channel: "stable".into(),
            update_source: "github".into(),
            update_source_url: String::new(),
            update_check_interval: "daily".into(),
            skipped_version: None,
            last_update_check: None,
            close_to_tray: false,
            release_webview_in_tray: true,
            lightweight_mode: false,
            show_dock_icon_in_background: true,
            title_bar_style: if cfg!(target_os = "windows") {
                "compact"
            } else {
                "system"
            }
            .into(),
            record_terminal_history: false,
            preload_dirs: true,
            preload_count: 4,
            motion: "system".into(),
            show_status_bar: true,
            restore_workspace: true,
            host_activation: "terminal".into(),
            host_direct_connect: true,
            terminal_scrollback: 10_000,
            terminal_line_height: 1.2,
            terminal_cursor_style: "block".into(),
            terminal_cursor_blink: true,
            terminal_inactive_cursor_style: "outline".into(),
            terminal_scroll_sensitivity: 1,
            terminal_smooth_scrolling: false,
            terminal_scroll_on_input: true,
            terminal_copy_on_select: false,
            terminal_right_click: "menu".into(),
            terminal_renderer: "auto".into(),
            file_icon_theme: "auto".into(),
            files_show_hidden: false,
            files_folders_first: true,
            files_sort_by: "name".into(),
            files_sort_direction: "asc".into(),
            transfer_optimization: true,
            transfer_compression: true,
            transfer_concurrency: 0,
            transfer_chunk_kib: 0,
            transfer_requests: 0,
            transfer_upload_limit_kib: 0,
            transfer_download_limit_kib: 0,
            editor_word_wrap: false,
            editor_tab_size: 4,
            editor_spell_check: false,
            monitor_interval_ms: 3000,
        }
    }
}

fn is_hex_color(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 7 && bytes[0] == b'#' && bytes[1..].iter().all(|b| b.is_ascii_hexdigit())
}

fn is_keyboard_shortcut(value: &str) -> bool {
    if value.is_empty() || value.len() > 64 || !value.is_ascii() {
        return false;
    }
    let mut parts: Vec<&str> = value.split('+').collect();
    let key = parts.pop().unwrap_or_default();
    let allowed = ["Mod", "Ctrl", "Meta", "Alt", "Shift"];
    if parts.iter().any(|part| !allowed.contains(part))
        || parts
            .iter()
            .enumerate()
            .any(|(index, part)| parts[..index].contains(part))
        || (parts.contains(&"Mod") && (parts.contains(&"Ctrl") || parts.contains(&"Meta")))
        || (parts.contains(&"Ctrl") && parts.contains(&"Meta"))
    {
        return false;
    }
    (key.len() == 1 && key.bytes().all(|byte| byte.is_ascii_alphanumeric()))
        || key
            .strip_prefix('F')
            .and_then(|suffix| suffix.parse::<u8>().ok())
            .is_some_and(|number| (1..=24).contains(&number))
        || [
            "Comma",
            "Period",
            "Backslash",
            "Equal",
            "Plus",
            "Minus",
            "Space",
            "Escape",
            "Tab",
            "Enter",
            "Backspace",
            "Delete",
            "Insert",
            "Home",
            "End",
            "PageUp",
            "PageDown",
            "ArrowUp",
            "ArrowDown",
            "ArrowLeft",
            "ArrowRight",
        ]
        .contains(&key)
}

impl Settings {
    /// Clamp and whitelist every field so a bad patch can never persist
    /// values that break the layout or the update state machine.
    pub fn sanitize(&mut self) {
        let mut shortcut_count = 0;
        self.keyboard_shortcuts.retain(|id, bindings| {
            let valid = id.len() <= 256
                && id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'))
                && [
                    "palette.",
                    "page.",
                    "keyboard.",
                    "host.",
                    "sidebar.",
                    "update.",
                    "panel.",
                    "theme.",
                    "font.",
                    "tab.",
                    "pane.",
                    "editor.",
                    "terminal.",
                    "files.",
                    "plugin.",
                ]
                .iter()
                .any(|prefix| id.starts_with(prefix))
                && bindings.len() <= 4
                && bindings.iter().all(|binding| is_keyboard_shortcut(binding));
            if valid {
                shortcut_count += 1;
            }
            valid && shortcut_count <= 128
        });
        if self.file_icon_theme.is_empty()
            || self.file_icon_theme.len() > 129
            || !self
                .file_icon_theme
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b':' | b'.'))
        {
            self.file_icon_theme = "auto".into();
        }
        let defaults = Self::default();
        if ![0, 1, 2, 4, 8].contains(&self.transfer_concurrency) {
            self.transfer_concurrency = 0;
        }
        if ![0, 256, 1024, 4096, 16384].contains(&self.transfer_chunk_kib) {
            self.transfer_chunk_kib = 0;
        }
        if ![0, 1, 4, 8, 16, 32].contains(&self.transfer_requests) {
            self.transfer_requests = 0;
        }
        self.transfer_upload_limit_kib = self.transfer_upload_limit_kib.min(1_048_576);
        self.transfer_download_limit_kib = self.transfer_download_limit_kib.min(1_048_576);
        if !["stable", "beta"].contains(&self.update_channel.as_str()) {
            self.update_channel = defaults.update_channel.clone();
        }
        if !["github", "custom"].contains(&self.update_source.as_str()) {
            self.update_source = "github".into();
        }
        if !["startup", "daily", "weekly"].contains(&self.update_check_interval.as_str()) {
            self.update_check_interval = "daily".into();
        }
        if !TITLE_BAR_STYLES.contains(&self.title_bar_style.as_str()) {
            self.title_bar_style = defaults.title_bar_style;
        }
        if !LANGUAGES.contains(&self.language.as_str()) {
            self.language = "system".into();
        }
        if !THEMES.contains(&self.theme.as_str()) {
            self.theme = "system".into();
        }
        if !ACCENTS.contains(&self.accent.as_str()) && !is_hex_color(&self.accent) {
            self.accent = "blue".into();
        }
        self.colors.retain(|region, value| {
            COLOR_REGIONS.contains(&region.as_str()) && is_hex_color(value)
        });
        for value in self.colors.values_mut() {
            *value = value.to_ascii_lowercase();
        }
        if !DENSITIES.contains(&self.density.as_str()) {
            self.density = "comfortable".into();
        }
        self.ui_font_size = self.ui_font_size.clamp(11, 20);
        self.mono_font_size = self.mono_font_size.clamp(10, 32);
        self.preload_count = self.preload_count.min(32);
        if !MONO_FONTS.contains(&self.mono_font.as_str()) {
            self.mono_font = "fira-code".into();
        }
        self.sidebar_width = self.sidebar_width.clamp(220, 420);
        self.right_panel_width = self.right_panel_width.clamp(240, 460);
        for (value, allowed, fallback) in [
            (
                &mut self.motion,
                &["system", "reduced", "full"][..],
                "system",
            ),
            (
                &mut self.host_activation,
                &["terminal", "details", "edit"][..],
                "terminal",
            ),
            (
                &mut self.terminal_cursor_style,
                &["block", "bar", "underline"][..],
                "block",
            ),
            (
                &mut self.terminal_inactive_cursor_style,
                &["outline", "block", "bar", "underline", "none"][..],
                "outline",
            ),
            (
                &mut self.terminal_right_click,
                &["menu", "copyPaste", "paste"][..],
                "menu",
            ),
            (&mut self.terminal_renderer, &["auto", "dom"][..], "auto"),
            (
                &mut self.files_sort_by,
                &["name", "size", "modified"][..],
                "name",
            ),
            (&mut self.files_sort_direction, &["asc", "desc"][..], "asc"),
        ] {
            if !allowed.contains(&value.as_str()) {
                *value = fallback.into();
            }
        }
        self.terminal_scrollback = self.terminal_scrollback.clamp(1000, 100_000);
        self.terminal_scroll_sensitivity = self.terminal_scroll_sensitivity.clamp(1, 5);
        self.terminal_line_height = if self.terminal_line_height.is_finite() {
            (self.terminal_line_height.clamp(1.0, 1.8) * 10.0).round() / 10.0
        } else {
            1.2
        };
        if ![2, 4, 8].contains(&self.editor_tab_size) {
            self.editor_tab_size = 4;
        }
        if !MONITOR_INTERVALS.contains(&self.monitor_interval_ms) {
            self.monitor_interval_ms = 3000;
        }
        if self.user_css.len() > 200_000 {
            let mut end = 200_000;
            while !self.user_css.is_char_boundary(end) {
                end -= 1;
            }
            self.user_css.truncate(end);
        }
        if let Some(version) = &self.skipped_version {
            if version.trim().is_empty() {
                self.skipped_version = None;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn regional_colors_validate_and_survive_theme_switches_and_round_trip() {
        let mut settings: Settings = serde_json::from_value(serde_json::json!({ "colors": {
            "background": "#AABBCC", "terminalCursor": "#123456", "sidebar": "red", "panel": "#fff", "unknownRegion": "#123456"
        } })).unwrap();
        settings.sanitize();
        assert_eq!(settings.colors.len(), 2);
        assert_eq!(settings.colors["background"], "#aabbcc");
        let saved = settings.colors.clone();
        for theme in THEMES {
            settings.theme = theme.into();
            settings.sanitize();
            assert_eq!(settings.colors, saved);
        }
        let restored: Settings =
            serde_json::from_str(&serde_json::to_string(&settings).unwrap()).unwrap();
        assert_eq!(restored.colors, saved);
        let legacy: Settings = serde_json::from_str("{}").unwrap();
        assert!(legacy.colors.is_empty());
    }

    #[test]
    fn truncates_multibyte_css_on_a_character_boundary() {
        let mut settings = Settings {
            user_css: "中".repeat(70_000),
            ..Settings::default()
        };
        settings.sanitize();
        assert_eq!(settings.user_css.len(), 199_998);
        assert!(settings.user_css.chars().all(|value| value == '中'));
    }

    #[test]
    fn keyboard_shortcuts_preserve_disable_and_bound_untrusted_imports() {
        let mut settings: Settings = serde_json::from_value(serde_json::json!({
            "keyboardShortcuts": {
                "page.settings": ["Mod+Shift+Y"],
                "terminal.copy": [],
                "files.rename": ["F2", "F3", "F4", "F5", "F6"],
                "page.about": ["Mod+\nA"],
                "page.fake": ["Garbage"],
                "page.bad": ["Ctrl+Ctrl+A"],
                "unknown.command": ["Mod+X"]
            }
        }))
        .unwrap();
        settings.sanitize();
        assert_eq!(settings.keyboard_shortcuts.len(), 2);
        assert_eq!(
            settings.keyboard_shortcuts["page.settings"],
            vec!["Mod+Shift+Y"]
        );
        assert!(settings.keyboard_shortcuts["terminal.copy"].is_empty());
        let restored: Settings =
            serde_json::from_str(&serde_json::to_string(&settings).unwrap()).unwrap();
        assert_eq!(restored.keyboard_shortcuts, settings.keyboard_shortcuts);
        assert!(serde_json::from_str::<Settings>("{}")
            .unwrap()
            .keyboard_shortcuts
            .is_empty());
        for index in 0..150 {
            settings
                .keyboard_shortcuts
                .insert(format!("page.future{index}"), vec!["Mod+M".into()]);
        }
        settings.sanitize();
        assert_eq!(settings.keyboard_shortcuts.len(), 128);
    }

    #[test]
    fn legacy_development_update_preferences_migrate_to_stable() {
        let mut settings: Settings = serde_json::from_value(serde_json::json!({
            "updateChannel": "nightly",
            "theme": "dark"
        }))
        .unwrap();
        settings.sanitize();
        assert_eq!(settings.update_channel, "stable");
        assert_eq!(settings.theme, "dark");
        settings.update_channel = "beta".into();
        settings.sanitize();
        assert_eq!(settings.update_channel, "beta");
    }

    #[test]
    fn defaults_need_no_repair() {
        let mut settings = Settings::default();
        let before = serde_json::to_value(&settings).unwrap();
        settings.sanitize();
        assert_eq!(serde_json::to_value(&settings).unwrap(), before);
        assert_eq!(settings.theme, "system");
        assert_eq!(settings.update_channel, "stable");
        assert_eq!(settings.accent, "blue");
        assert_eq!(settings.density, "comfortable");
        assert_eq!(settings.ui_font_size, 13);
        assert_eq!(settings.mono_font_size, 14);
        assert!(!settings.right_panel);
        assert_eq!(settings.preload_count, 4);
        assert_eq!(settings.motion, "system");
        assert!(settings.show_status_bar);
        assert!(settings.restore_workspace);
        assert_eq!(settings.host_activation, "terminal");
        assert_eq!(settings.monitor_interval_ms, 3000);
        assert_eq!(settings.terminal_line_height, 1.2);
        assert_eq!(settings.terminal_scrollback, 10_000);
        assert_eq!(
            settings.title_bar_style,
            if cfg!(target_os = "windows") {
                "compact"
            } else {
                "system"
            }
        );
    }

    #[test]
    fn bandwidth_limits_migrate_clamp_and_roundtrip() {
        let mut settings: Settings = serde_json::from_str("{}").unwrap();
        assert_eq!(
            (
                settings.transfer_upload_limit_kib,
                settings.transfer_download_limit_kib
            ),
            (0, 0)
        );
        settings.transfer_upload_limit_kib = u32::MAX;
        settings.transfer_download_limit_kib = 1024;
        settings.sanitize();
        let restored: Settings =
            serde_json::from_str(&serde_json::to_string(&settings).unwrap()).unwrap();
        assert_eq!(
            (
                restored.transfer_upload_limit_kib,
                restored.transfer_download_limit_kib
            ),
            (1_048_576, 1024)
        );
    }

    #[test]
    fn transfer_settings_migrate_sanitize_and_round_trip() {
        let legacy: Settings = serde_json::from_str("{}").unwrap();
        assert!(legacy.transfer_optimization);
        assert!(legacy.transfer_compression);
        assert_eq!(legacy.transfer_concurrency, 0);
        assert_eq!(legacy.transfer_chunk_kib, 0);
        assert_eq!(legacy.transfer_requests, 0);
        for (concurrency, chunk, requests) in [(0, 0, 0), (1, 256, 1), (8, 16384, 32), (4, 4096, 8)]
        {
            let mut settings: Settings = serde_json::from_value(serde_json::json!({
                "transferOptimization": false, "transferCompression": false, "transferConcurrency": concurrency,
                "transferChunkKib": chunk, "transferRequests": requests
            }))
            .unwrap();
            settings.sanitize();
            let restored: Settings =
                serde_json::from_str(&serde_json::to_string(&settings).unwrap()).unwrap();
            assert!(!restored.transfer_optimization);
            assert!(!restored.transfer_compression);
            assert_eq!(restored.transfer_concurrency, concurrency);
            assert_eq!(restored.transfer_chunk_kib, chunk);
            assert_eq!(restored.transfer_requests, requests);
        }
        let mut invalid: Settings = serde_json::from_value(serde_json::json!({
            "transferConcurrency": 999, "transferChunkKib": 99, "transferRequests": 65535
        }))
        .unwrap();
        invalid.sanitize();
        assert_eq!(
            (
                invalid.transfer_concurrency,
                invalid.transfer_chunk_kib,
                invalid.transfer_requests
            ),
            (0, 0, 0)
        );
    }

    #[test]
    fn plugin_command_bindings_survive_profile_serialization_with_safe_identifiers() {
        let mut settings = Settings::default();
        settings.keyboard_shortcuts.insert(
            "plugin.c.12.example-tool.generate_uuid".into(),
            vec!["Mod+Shift+U".into()],
        );
        settings
            .keyboard_shortcuts
            .insert("plugin.c.bad/path".into(), vec!["F1".into()]);
        settings.sanitize();
        let mut restored: Settings =
            serde_json::from_str(&serde_json::to_string(&settings).unwrap()).unwrap();
        restored.sanitize();
        assert_eq!(restored.keyboard_shortcuts.len(), 1);
        assert_eq!(
            restored.keyboard_shortcuts["plugin.c.12.example-tool.generate_uuid"],
            vec!["Mod+Shift+U"]
        );
    }

    #[test]
    fn title_bar_styles_round_trip_and_invalid_values_use_platform_default() {
        for style in TITLE_BAR_STYLES {
            let mut settings: Settings =
                serde_json::from_value(serde_json::json!({ "titleBarStyle": style })).unwrap();
            settings.sanitize();
            assert_eq!(settings.title_bar_style, style);
            assert_eq!(
                serde_json::to_value(&settings).unwrap()["titleBarStyle"],
                style
            );
        }
        for style in ["", "overlay", "COMPACT"] {
            let mut settings = Settings {
                title_bar_style: style.into(),
                ..Settings::default()
            };
            settings.sanitize();
            assert_eq!(
                settings.title_bar_style,
                Settings::default().title_bar_style
            );
        }
        let legacy: Settings = serde_json::from_value(serde_json::json!({
            "menuMode": "both", "nativeMenu": true
        }))
        .unwrap();
        assert_eq!(legacy.title_bar_style, Settings::default().title_bar_style);
    }

    #[test]
    fn clamps_and_whitelists() {
        let mut settings = Settings {
            language: "fr".into(),
            theme: "neon".into(),
            accent: "purple".into(),
            density: "dense".into(),
            ui_font_size: 99,
            mono_font_size: 1,
            mono_font: "comic".into(),
            sidebar_width: 10,
            right_panel_width: 9999,
            ..Settings::default()
        };

        settings.sanitize();

        assert_eq!(settings.language, "system");
        assert_eq!(settings.theme, "system");
        assert_eq!(settings.accent, "blue");
        assert_eq!(settings.density, "comfortable");
        assert_eq!(settings.ui_font_size, 20);
        assert_eq!(settings.mono_font_size, 10);
        assert_eq!(settings.mono_font, "fira-code");
        assert_eq!(settings.sidebar_width, 220);
        assert_eq!(settings.right_panel_width, 460);
    }

    #[test]
    fn keeps_custom_hex_accents() {
        let mut settings = Settings {
            accent: "#a1B2c3".into(),
            ..Settings::default()
        };
        settings.sanitize();
        assert_eq!(settings.accent, "#a1B2c3");
    }

    #[test]
    fn drops_blank_skipped_versions() {
        let mut settings = Settings {
            skipped_version: Some("   ".into()),
            ..Settings::default()
        };
        settings.sanitize();
        assert!(settings.skipped_version.is_none());
    }

    #[test]
    fn legacy_preferences_are_preserved_and_missing_fields_get_current_defaults() {
        let mut settings: Settings = serde_json::from_value(serde_json::json!({
            "language": "zh-CN",
            "theme": "dark",
            "density": "compact",
            "monoFontSize": 13,
            "uiFontSize": 12,
            "rightPanel": true,
            "titleBarStyle": "system",
            "preloadCount": 8,
            "recordTerminalHistory": true,
            "userCss": ":root { --custom-color: #123456; }",
            "menuMode": "both",
            "nativeMenu": true
        }))
        .unwrap();
        settings.sanitize();
        let saved = serde_json::to_value(settings).unwrap();
        assert_eq!(saved["language"], "zh-CN");
        assert_eq!(saved["theme"], "dark");
        assert_eq!(saved["density"], "compact");
        assert_eq!(saved["monoFontSize"], 13);
        assert_eq!(saved["uiFontSize"], 12);
        assert_eq!(saved["rightPanel"], true);
        assert_eq!(saved["titleBarStyle"], "system");
        assert_eq!(saved["preloadCount"], 8);
        assert_eq!(saved["recordTerminalHistory"], true);
        assert_eq!(saved["userCss"], ":root { --custom-color: #123456; }");
        assert!(saved.get("menuMode").is_none());
        assert!(saved.get("nativeMenu").is_none());

        let defaults = serde_json::to_value(Settings::default()).unwrap();
        for key in [
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
            "filesShowHidden",
            "filesFoldersFirst",
            "filesSortBy",
            "filesSortDirection",
            "editorWordWrap",
            "editorTabSize",
            "editorSpellCheck",
            "monitorIntervalMs",
        ] {
            assert_eq!(saved[key], defaults[key], "missing legacy field {key}");
        }
        let empty: Settings = serde_json::from_str("{}").unwrap();
        assert_eq!(serde_json::to_value(empty).unwrap(), defaults);
    }

    #[test]
    fn new_preferences_survive_sanitize_and_json_round_trip() {
        let input = serde_json::json!({
            "motion": "full", "showStatusBar": false, "restoreWorkspace": false,
            "hostActivation": "edit", "hostDirectConnect": false, "terminalScrollback": 100_000,
            "terminalLineHeight": 1.5, "terminalCursorStyle": "underline",
            "terminalCursorBlink": false, "terminalInactiveCursorStyle": "none",
            "terminalScrollSensitivity": 5, "terminalSmoothScrolling": true,
            "terminalScrollOnInput": false, "terminalCopyOnSelect": true,
            "terminalRightClick": "copyPaste", "terminalRenderer": "dom",
            "filesShowHidden": true, "filesFoldersFirst": false,
            "filesSortBy": "modified", "filesSortDirection": "desc",
            "editorWordWrap": true, "editorTabSize": 8, "editorSpellCheck": true,
            "monitorIntervalMs": 30_000
        });
        let mut settings: Settings = serde_json::from_value(input.clone()).unwrap();
        settings.sanitize();
        let saved = serde_json::to_value(&settings).unwrap();
        for (key, value) in input.as_object().unwrap() {
            assert_eq!(&saved[key], value, "new preference {key}");
        }
        let mut reloaded: Settings =
            serde_json::from_str(&serde_json::to_string(&settings).unwrap()).unwrap();
        reloaded.sanitize();
        assert_eq!(serde_json::to_value(reloaded).unwrap(), saved);
    }

    #[test]
    fn enum_choices_are_preserved_and_unknown_choices_fall_back() {
        let cases: &[(&str, &[&str])] = &[
            ("language", &LANGUAGES),
            ("theme", &THEMES),
            ("accent", &ACCENTS),
            ("density", &DENSITIES),
            ("monoFont", &MONO_FONTS),
            ("titleBarStyle", &TITLE_BAR_STYLES),
            ("updateChannel", &["stable", "beta"]),
            ("updateSource", &["github", "custom"]),
            ("updateCheckInterval", &["startup", "daily", "weekly"]),
            ("motion", &["system", "reduced", "full"]),
            ("hostActivation", &["terminal", "details", "edit"]),
            ("terminalCursorStyle", &["block", "bar", "underline"]),
            (
                "terminalInactiveCursorStyle",
                &["outline", "block", "bar", "underline", "none"],
            ),
            ("terminalRightClick", &["menu", "copyPaste", "paste"]),
            ("terminalRenderer", &["auto", "dom"]),
            ("filesSortBy", &["name", "size", "modified"]),
            ("filesSortDirection", &["asc", "desc"]),
        ];
        let defaults = serde_json::to_value(Settings::default()).unwrap();
        for (key, choices) in cases {
            for choice in *choices {
                let mut input = serde_json::Map::new();
                input.insert((*key).into(), serde_json::json!(choice));
                let mut settings: Settings = serde_json::from_value(input.into()).unwrap();
                settings.sanitize();
                assert_eq!(
                    serde_json::to_value(settings).unwrap()[key],
                    *choice,
                    "{key}: {choice}"
                );
            }
            for invalid in ["", "unknown", "FULL", " system "] {
                let mut input = serde_json::Map::new();
                input.insert((*key).into(), serde_json::json!(invalid));
                let mut settings: Settings = serde_json::from_value(input.into()).unwrap();
                settings.sanitize();
                assert_eq!(
                    serde_json::to_value(settings).unwrap()[key],
                    defaults[key],
                    "{key}: {invalid}"
                );
            }
        }
    }

    #[test]
    fn numeric_settings_clamp_to_supported_ranges() {
        let mut lower = Settings {
            ui_font_size: 0,
            mono_font_size: 0,
            sidebar_width: 0,
            right_panel_width: 0,
            preload_count: 0,
            terminal_scrollback: 0,
            terminal_scroll_sensitivity: 0,
            ..Settings::default()
        };
        lower.sanitize();
        assert_eq!(lower.ui_font_size, 11);
        assert_eq!(lower.mono_font_size, 10);
        assert_eq!(lower.sidebar_width, 220);
        assert_eq!(lower.right_panel_width, 240);
        assert_eq!(lower.preload_count, 0);
        assert_eq!(lower.terminal_scrollback, 1000);
        assert_eq!(lower.terminal_scroll_sensitivity, 1);
        let mut upper = Settings {
            ui_font_size: u16::MAX,
            mono_font_size: u16::MAX,
            sidebar_width: u16::MAX,
            right_panel_width: u16::MAX,
            preload_count: u16::MAX,
            terminal_scrollback: u32::MAX,
            terminal_scroll_sensitivity: u16::MAX,
            ..Settings::default()
        };
        upper.sanitize();
        assert_eq!(upper.ui_font_size, 20);
        assert_eq!(upper.mono_font_size, 32);
        assert_eq!(upper.sidebar_width, 420);
        assert_eq!(upper.right_panel_width, 460);
        assert_eq!(upper.preload_count, 32);
        assert_eq!(upper.terminal_scrollback, 100_000);
        assert_eq!(upper.terminal_scroll_sensitivity, 5);
        let stable = serde_json::to_value(&upper).unwrap();
        upper.sanitize();
        assert_eq!(serde_json::to_value(upper).unwrap(), stable);
    }

    #[test]
    fn discrete_numeric_choices_reject_unsupported_values() {
        for interval in MONITOR_INTERVALS {
            let mut settings = Settings {
                monitor_interval_ms: interval,
                ..Settings::default()
            };
            settings.sanitize();
            assert_eq!(settings.monitor_interval_ms, interval);
        }
        for interval in [0, 500, 1001, 4000, 30_001, u32::MAX] {
            let mut settings = Settings {
                monitor_interval_ms: interval,
                ..Settings::default()
            };
            settings.sanitize();
            assert_eq!(settings.monitor_interval_ms, 3000);
        }
        for size in [2, 4, 8] {
            let mut settings = Settings {
                editor_tab_size: size,
                ..Settings::default()
            };
            settings.sanitize();
            assert_eq!(settings.editor_tab_size, size);
        }
        for size in [0, 1, 3, 9, u16::MAX] {
            let mut settings = Settings {
                editor_tab_size: size,
                ..Settings::default()
            };
            settings.sanitize();
            assert_eq!(settings.editor_tab_size, 4);
        }
    }

    #[test]
    fn line_height_is_finite_clamped_and_rounded_before_persistence() {
        for (input, expected) in [
            (f64::NAN, 1.2),
            (f64::INFINITY, 1.2),
            (f64::NEG_INFINITY, 1.2),
            (-10.0, 1.0),
            (0.9, 1.0),
            (1.0, 1.0),
            (1.24, 1.2),
            (1.25, 1.3),
            (1.74, 1.7),
            (1.75, 1.8),
            (1.8, 1.8),
            (100.0, 1.8),
        ] {
            let mut settings = Settings {
                terminal_line_height: input,
                ..Settings::default()
            };
            settings.sanitize();
            assert_eq!(
                settings.terminal_line_height, expected,
                "line height {input}"
            );
            let saved = serde_json::to_value(&settings).unwrap();
            assert_eq!(saved["terminalLineHeight"], expected);
            settings.sanitize();
            assert_eq!(settings.terminal_line_height, expected);
        }
    }

    #[test]
    fn malformed_typed_values_are_rejected_instead_of_silently_becoming_defaults() {
        for input in [
            serde_json::json!({ "uiFontSize": -1 }),
            serde_json::json!({ "terminalScrollback": -1 }),
            serde_json::json!({ "monitorIntervalMs": "1000" }),
            serde_json::json!({ "showStatusBar": "false" }),
            serde_json::json!({ "terminalLineHeight": null }),
            serde_json::json!({ "motion": false }),
        ] {
            assert!(
                serde_json::from_value::<Settings>(input.clone()).is_err(),
                "{input}"
            );
        }
    }
}
