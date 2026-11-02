import type { MonoFont, Settings } from "../api/types";

export const MONO_FONT_SIZE_MIN = 10;
export const MONO_FONT_SIZE_MAX = 32;
export const UI_FONT_SIZE_MIN = 11;
export const UI_FONT_SIZE_MAX = 20;

export function createDefaultSettings(platform = "unknown"): Settings {
  return {
    keyboardShortcuts: {},
    language: "system",
    theme: "system",
    accent: "blue",
    colors: {},
    density: "comfortable",
    uiFontSize: 13,
    monoFontSize: 14,
    monoFont: "fira-code",
    sidebarWidth: 272,
    rightPanel: false,
    rightPanelWidth: 296,
    userCss: "",
    autoCheckUpdates: true,
    skippedVersion: null,
    lastUpdateCheck: null,
    closeToTray: false,
    showDockIconInBackground: true,
    titleBarStyle: platform === "windows" ? "compact" : "system",
    recordTerminalHistory: false,
    preloadDirs: true,
    preloadCount: 4,
    motion: "system",
    showStatusBar: true,
    restoreWorkspace: true,
    hostActivation: "terminal",
    hostDirectConnect: true,
    terminalScrollback: 10_000,
    terminalLineHeight: 1.2,
    terminalCursorStyle: "block",
    terminalCursorBlink: true,
    terminalInactiveCursorStyle: "outline",
    terminalScrollSensitivity: 1,
    terminalSmoothScrolling: false,
    terminalScrollOnInput: true,
    terminalCopyOnSelect: false,
    terminalRightClick: "menu",
    terminalRenderer: "auto",
    filesShowHidden: false,
    filesFoldersFirst: true,
    filesSortBy: "name",
    filesSortDirection: "asc",
    editorWordWrap: false,
    editorTabSize: 4,
    editorSpellCheck: false,
    monitorIntervalMs: 3000,
  };
}

export const DEFAULT_SETTINGS = createDefaultSettings();

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
