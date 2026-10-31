// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

use serde::{Deserialize, Serialize};

pub const LANGUAGES: [&str; 3] = ["system", "zh-CN", "en-US"];
pub const THEMES: [&str; 3] = ["dark", "light", "system"];
pub const ACCENTS: [&str; 5] = ["blue", "cyan", "green", "orange", "violet"];
pub const DENSITIES: [&str; 2] = ["comfortable", "compact"];
pub const MONO_FONTS: [&str; 4] = ["fira-code", "jetbrains-mono", "plex-mono", "system"];

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// "system" | "zh-CN" | "en-US"
    pub language: String,
    /// "dark" | "light" | "system"
    pub theme: String,
    /// Preset id from [`ACCENTS`].
    pub accent: String,
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
    pub skipped_version: Option<String>,
    pub last_update_check: Option<i64>,
    pub close_to_tray: bool,
    /// Show the OS menu bar instead of relying on the in-app chrome only.
    pub native_menu: bool,
    /// Warm the parent and neighbouring folders of an open file panel.
    pub preload_dirs: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            language: "system".into(),
            theme: "dark".into(),
            accent: "blue".into(),
            density: "comfortable".into(),
            ui_font_size: 13,
            mono_font_size: 13,
            mono_font: "fira-code".into(),
            sidebar_width: 272,
            right_panel: true,
            right_panel_width: 296,
            user_css: String::new(),
            auto_check_updates: true,
            skipped_version: None,
            last_update_check: None,
            close_to_tray: false,
            native_menu: cfg!(target_os = "macos"),
            preload_dirs: false,
        }
    }
}

fn is_hex_color(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 7 && bytes[0] == b'#' && bytes[1..].iter().all(|b| b.is_ascii_hexdigit())
}

impl Settings {
    /// Clamp and whitelist every field so a bad patch can never persist
    /// values that break the layout or the update state machine.
    pub fn sanitize(&mut self) {
        if !LANGUAGES.contains(&self.language.as_str()) {
            self.language = "system".into();
        }
        if !THEMES.contains(&self.theme.as_str()) {
            self.theme = "dark".into();
        }
        if !ACCENTS.contains(&self.accent.as_str()) && !is_hex_color(&self.accent) {
            self.accent = "blue".into();
        }
        if !DENSITIES.contains(&self.density.as_str()) {
            self.density = "comfortable".into();
        }
        self.ui_font_size = self.ui_font_size.clamp(11, 16);
        self.mono_font_size = self.mono_font_size.clamp(11, 20);
        if !MONO_FONTS.contains(&self.mono_font.as_str()) {
            self.mono_font = "fira-code".into();
        }
        self.sidebar_width = self.sidebar_width.clamp(220, 420);
        self.right_panel_width = self.right_panel_width.clamp(240, 460);
        if self.user_css.len() > 200_000 {
            self.user_css.truncate(200_000);
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
    fn defaults_need_no_repair() {
        let mut settings = Settings::default();
        settings.sanitize();
        assert_eq!(settings.theme, "dark");
        assert_eq!(settings.accent, "blue");
        assert_eq!(settings.density, "comfortable");
        assert_eq!(settings.ui_font_size, 13);
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
        assert_eq!(settings.theme, "dark");
        assert_eq!(settings.accent, "blue");
        assert_eq!(settings.density, "comfortable");
        assert_eq!(settings.ui_font_size, 16);
        assert_eq!(settings.mono_font_size, 11);
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
}
