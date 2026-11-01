import type { Settings } from "@/lib/api/types";
import type { ParseKeys } from "i18next";
import {
  MONO_FONT_OPTIONS,
  MONO_FONT_SIZE_MAX,
  MONO_FONT_SIZE_MIN,
  UI_FONT_SIZE_MAX,
  UI_FONT_SIZE_MIN,
} from "@/lib/prefs/defaults";
import type { SettingsSection } from "@/store/navigation";

export type SettingKey = Exclude<keyof Settings, "lastUpdateCheck" | "skippedVersion">;
export type MessageKey = ParseKeys;
export type SettingOption = {
  value: string | number;
} & ({ label: MessageKey; literal?: false } | { label: string; literal: true });
export interface SettingDefinition {
  key: SettingKey;
  section: SettingsSection;
  label: MessageKey;
  kind: "toggle" | "number" | "select" | "accent" | "colors" | "css";
  hint?: MessageKey;
  options?: SettingOption[];
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  dependsOn?: "preloadDirs";
  hideOnMac?: boolean;
}

export const SETTINGS_SECTIONS: SettingsSection[] = [
  "general",
  "appearance",
  "workspace",
  "terminal",
  "files",
  "editor",
  "monitor",
  "updates",
  "plugins",
  "advanced",
];
export const SECTION_LABELS: Record<SettingsSection, MessageKey> = {
  general: "settings.general",
  appearance: "settings.appearance",
  workspace: "settings.workspace",
  terminal: "settings.terminal",
  files: "settings.files",
  editor: "settings.editor",
  monitor: "settings.monitor",
  updates: "settings.updatesSection",
  plugins: "settings.plugins",
  advanced: "settings.advanced",
};
const choice = (value: string | number, label: MessageKey): SettingOption => ({ value, label });
const toggle = (
  key: SettingKey,
  section: SettingsSection,
  hint?: MessageKey,
): SettingDefinition => ({
  key,
  section,
  label: `settings.${key}` as MessageKey,
  kind: "toggle",
  hint,
});
const numeric = (
  key: SettingKey,
  section: SettingsSection,
  min: number,
  max: number,
  step = 1,
  unit?: string,
): SettingDefinition => ({
  key,
  section,
  label: `settings.${key}` as MessageKey,
  kind: "number",
  min,
  max,
  step,
  unit,
});
const select = (
  key: SettingKey,
  section: SettingsSection,
  options: SettingOption[],
  hint?: MessageKey,
): SettingDefinition => ({
  key,
  section,
  label: `settings.${key}` as MessageKey,
  kind: "select",
  options,
  hint,
});
const cursorOptions = [
  choice("block", "settings.cursorBlock"),
  choice("bar", "settings.cursorBar"),
  choice("underline", "settings.cursorUnderline"),
];

/** Every editable preference appears here once: rendering, search and scoped reset share it. */
export const SETTINGS_CATALOG: SettingDefinition[] = [
  select("language", "general", [
    choice("system", "settings.languageSystem"),
    { value: "zh-CN", label: "简体中文", literal: true },
    { value: "en-US", label: "English", literal: true },
  ]),
  {
    ...select(
      "titleBarStyle",
      "general",
      [choice("system", "settings.titleBarSystem"), choice("compact", "settings.titleBarCompact")],
      "settings.titleBarHint",
    ),
    label: "settings.titleBar",
  },
  { ...toggle("closeToTray", "general", "settings.closeToTrayHint"), hideOnMac: true },
  select("theme", "appearance", [
    choice("system", "settings.themeSystem"),
    choice("dark", "settings.themeDark"),
    choice("light", "settings.themeLight"),
  ]),
  { key: "accent", section: "appearance", label: "settings.accent", kind: "accent" },
  {
    key: "colors",
    section: "appearance",
    label: "color.regions",
    hint: "color.regionsHint",
    kind: "colors",
  },
  select("density", "appearance", [
    choice("comfortable", "settings.densityComfortable"),
    choice("compact", "settings.densityCompact"),
  ]),
  numeric("uiFontSize", "appearance", UI_FONT_SIZE_MIN, UI_FONT_SIZE_MAX, 1, "px"),
  numeric("monoFontSize", "appearance", MONO_FONT_SIZE_MIN, MONO_FONT_SIZE_MAX, 1, "px"),
  select(
    "monoFont",
    "appearance",
    MONO_FONT_OPTIONS.map((font) => ({ ...font, literal: true })),
    "settings.monoFontHint",
  ),
  select(
    "motion",
    "appearance",
    [
      choice("system", "settings.motionSystem"),
      choice("reduced", "settings.motionReduced"),
      choice("full", "settings.motionFull"),
    ],
    "settings.motionHint",
  ),
  toggle("showStatusBar", "workspace"),
  toggle("rightPanel", "workspace", "settings.rightPanelHint"),
  toggle("restoreWorkspace", "workspace", "settings.restoreWorkspaceHint"),
  numeric("sidebarWidth", "workspace", 220, 420, 1, "px"),
  numeric("rightPanelWidth", "workspace", 240, 460, 1, "px"),
  select(
    "hostActivation",
    "workspace",
    [
      choice("terminal", "settings.hostConnect"),
      choice("details", "settings.hostDetails"),
      choice("edit", "settings.hostEdit"),
    ],
    "settings.hostActivationHint",
  ),
  {
    ...numeric("terminalScrollback", "terminal", 1000, 100000, 1000),
    hint: "settings.terminalScrollbackHint",
  },
  numeric("terminalLineHeight", "terminal", 1, 1.8, 0.1),
  select("terminalCursorStyle", "terminal", cursorOptions),
  toggle("terminalCursorBlink", "terminal"),
  select("terminalInactiveCursorStyle", "terminal", [
    choice("outline", "settings.cursorOutline"),
    ...cursorOptions,
    choice("none", "settings.cursorNone"),
  ]),
  numeric("terminalScrollSensitivity", "terminal", 1, 5),
  toggle("terminalSmoothScrolling", "terminal", "settings.terminalSmoothScrollingHint"),
  toggle("terminalScrollOnInput", "terminal", "settings.terminalScrollOnInputHint"),
  toggle("terminalCopyOnSelect", "terminal"),
  select(
    "terminalRightClick",
    "terminal",
    [
      choice("menu", "settings.rightClickMenu"),
      choice("copyPaste", "settings.rightClickCopyPaste"),
      choice("paste", "settings.rightClickPaste"),
    ],
    "settings.terminalRightClickHint",
  ),
  select(
    "terminalRenderer",
    "terminal",
    [choice("auto", "settings.rendererAuto"), choice("dom", "settings.rendererDom")],
    "settings.terminalRendererHint",
  ),
  toggle("recordTerminalHistory", "terminal", "settings.recordTerminalHistoryHint"),
  toggle("filesShowHidden", "files", "settings.filesShowHiddenHint"),
  toggle("filesFoldersFirst", "files"),
  select("filesSortBy", "files", [
    choice("name", "sftp.sortName"),
    choice("size", "sftp.sortSize"),
    choice("modified", "sftp.sortModified"),
  ]),
  select("filesSortDirection", "files", [
    choice("asc", "sftp.sortAscending"),
    choice("desc", "sftp.sortDescending"),
  ]),
  toggle("preloadDirs", "files", "settings.preloadDirsHint"),
  {
    ...numeric("preloadCount", "files", 0, 32),
    hint: "settings.preloadCountHint",
    dependsOn: "preloadDirs",
  },
  toggle("editorWordWrap", "editor", "settings.editorWordWrapHint"),
  select(
    "editorTabSize",
    "editor",
    [2, 4, 8].map((value) => ({ value, label: String(value), literal: true })),
    "settings.editorTabSizeHint",
  ),
  toggle("editorSpellCheck", "editor"),
  select(
    "monitorIntervalMs",
    "monitor",
    ([1, 2, 3, 5, 10, 30] as const).map((seconds) =>
      choice(seconds * 1000, `settings.seconds${seconds}`),
    ),
    "settings.monitorIntervalMsHint",
  ),
  { ...toggle("autoCheckUpdates", "updates"), label: "settings.autoCheck" },
  {
    key: "userCss",
    section: "advanced",
    label: "settings.customCss",
    kind: "css",
    hint: "settings.customCssHint",
  },
];
