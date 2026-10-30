// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import type { MonoFont, Settings } from "../api/types";

export const DEFAULT_SETTINGS: Settings = {
  language: "system",
  theme: "dark",
  accent: "blue",
  density: "comfortable",
  uiFontSize: 13,
  monoFontSize: 13,
  monoFont: "fira-code",
  sidebarWidth: 272,
  rightPanel: true,
  rightPanelWidth: 296,
  userCss: "",
  autoCheckUpdates: true,
  skippedVersion: null,
  lastUpdateCheck: null,
  closeToTray: false,
};

export type AccentLabelKey =
  | "settings.accentBlue"
  | "settings.accentCyan"
  | "settings.accentGreen"
  | "settings.accentOrange"
  | "settings.accentViolet";

export const ACCENT_SWATCHES: Array<{ id: string; color: string; labelKey: AccentLabelKey }> = [
  { id: "blue", color: "#2f6fed", labelKey: "settings.accentBlue" },
  { id: "cyan", color: "#35e0ff", labelKey: "settings.accentCyan" },
  { id: "green", color: "#3ddc97", labelKey: "settings.accentGreen" },
  { id: "orange", color: "#f2b84b", labelKey: "settings.accentOrange" },
  { id: "violet", color: "#8b7cf6", labelKey: "settings.accentViolet" },
];

/** Font families ship with the app, so the names stay untranslated. */
export const MONO_FONT_OPTIONS: Array<{ value: MonoFont; label: string }> = [
  { value: "fira-code", label: "Fira Code" },
  { value: "jetbrains-mono", label: "JetBrains Mono" },
  { value: "plex-mono", label: "IBM Plex Mono" },
  { value: "system", label: "System" },
];
