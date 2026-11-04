import type { Settings, SettingsPatch } from "@/lib/api/types";

/** Explicit allowlist: runtime metadata, host data and plugin secrets never leave their stores. */
export const PORTABLE_SETTING_KEYS = [
  "network",
  "language",
  "theme",
  "accent",
  "colors",
  "density",
  "uiFontSize",
  "monoFontSize",
  "monoFont",
  "sidebarWidth",
  "rightPanel",
  "rightPanelWidth",
  "userCss",
  "autoCheckUpdates",
  "updateChannel",
  "updateSource",
  "updateSourceUrl",
  "updateCheckInterval",
  "closeToTray",
  "releaseWebviewInTray",
  "lightweightMode",
  "showDockIconInBackground",
  "titleBarStyle",
  "recordTerminalHistory",
  "preloadDirs",
  "preloadCount",
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
  "fileIconTheme",
  "filesShowHidden",
  "filesFoldersFirst",
  "filesSortBy",
  "filesSortDirection",
  "transferOptimization",
  "transferConcurrency",
  "transferChunkKib",
  "transferRequests",
  "transferUploadLimitKib",
  "transferDownloadLimitKib",
  "editorWordWrap",
  "editorTabSize",
  "editorSpellCheck",
  "monitorIntervalMs",
  "keyboardShortcuts",
] as const;

export type PortableSettings = SettingsPatch;
export interface SettingsProfile {
  id: string;
  name: string;
  settings: PortableSettings;
  updatedAt: number;
}
export interface SettingsDocument {
  format: "tunnelde-settings";
  version: 1;
  name: string;
  settings: PortableSettings;
}

export function portableSettings(settings: Settings): PortableSettings {
  return structuredClone(
    Object.fromEntries(
      PORTABLE_SETTING_KEYS.filter((key) => key in settings).map((key) => [
        key,
        settings[key as keyof Settings],
      ]),
    ),
  );
}

/** Compare object keys recursively, without depending on JSON property ordering. */
export function sameSettings(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null)
    return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const entries = Object.entries(left);
  return (
    entries.length === Object.keys(right).length &&
    entries.every(
      ([key, value]) =>
        Object.hasOwn(right, key) && sameSettings(value, (right as Record<string, unknown>)[key]),
    )
  );
}

export function profileMatches(profile: SettingsProfile, settings: Settings): boolean {
  return sameSettings(profile.settings, portableSettings(settings));
}
