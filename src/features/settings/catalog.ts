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
  kind:
    | "toggle"
    | "number"
    | "select"
    | "accent"
    | "colors"
    | "fileIcons"
    | "css"
    | "shortcuts"
    | "shortcutRules"
    | "network"
    | "updateUrl";
  hint?: MessageKey;
  options?: SettingOption[];
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  dependsOn?: "preloadDirs" | "autoCheckUpdates" | "transferOptimization";
  hideOnMac?: boolean;
  macOnly?: boolean;
}

export const SETTINGS_SECTIONS: SettingsSection[] = [
  "general",
  "network",
  "appearance",
  "workspace",
  "terminal",
  "shortcuts",
  "files",
  "editor",
  "monitor",
  "updates",
  "plugins",
  "advanced",
  "about",
];
export const SECTION_LABELS: Record<SettingsSection, MessageKey> = {
  network: "network.title",
  general: "settings.general",
  appearance: "settings.appearance",
  workspace: "settings.workspace",
  terminal: "settings.terminal",
  shortcuts: "shortcuts.title",
  files: "settings.files",
  editor: "settings.editor",
  monitor: "settings.monitor",
  updates: "settings.updatesSection",
  plugins: "settings.plugins",
  advanced: "settings.advanced",
  about: "nav.about",
};

export interface SettingsGroup {
  id: string;
  label: MessageKey;
  keys: readonly SettingKey[];
  preview?: "terminal";
}

/** Navigation and inline headings share the same groups; no extra settings pages. */
export const SETTINGS_GROUPS: Partial<Record<SettingsSection, readonly SettingsGroup[]>> = {
  advanced: [{ id: "storage", label: "storage.title", keys: [] }],
  updates: [
    {
      id: "update-checks",
      label: "updates.checkPreferences",
      keys: ["autoCheckUpdates", "updateCheckInterval"],
    },
    { id: "update-channel", label: "updates.channel", keys: ["updateChannel"] },
    { id: "update-source", label: "updates.source", keys: ["updateSource", "updateSourceUrl"] },
  ],
  appearance: [
    { id: "theme", label: "settings.groups.theme", keys: ["theme", "accent", "colors"] },
    {
      id: "typography",
      label: "settings.groups.typography",
      keys: ["uiFontSize", "monoFont", "monoFontSize"],
    },
    { id: "interface", label: "settings.groups.interface", keys: ["density", "motion"] },
  ],
  workspace: [
    {
      id: "layout",
      label: "settings.groups.layout",
      keys: ["showStatusBar", "sidebarWidth", "rightPanel", "rightPanelWidth"],
    },
    {
      id: "startup",
      label: "settings.groups.startup",
      keys: ["restoreWorkspace", "hostActivation", "hostDirectConnect"],
    },
  ],
  terminal: [
    {
      id: "rendering",
      label: "settings.groups.rendering",
      keys: ["terminalLineHeight", "terminalRenderer"],
      preview: "terminal",
    },
    {
      id: "cursor",
      label: "settings.groups.cursor",
      keys: ["terminalCursorStyle", "terminalCursorBlink", "terminalInactiveCursorStyle"],
    },
    {
      id: "scrolling",
      label: "settings.groups.scrolling",
      keys: [
        "terminalScrollback",
        "terminalScrollSensitivity",
        "terminalSmoothScrolling",
        "terminalScrollOnInput",
      ],
    },
    {
      id: "clipboard",
      label: "settings.groups.clipboard",
      keys: ["terminalCopyOnSelect", "terminalApplicationClipboard", "terminalRightClick"],
    },
    { id: "history", label: "settings.groups.history", keys: ["recordTerminalHistory"] },
  ],
  files: [
    {
      id: "transfers",
      label: "settings.groups.transfers",
      keys: [
        "transferOptimization",
        "transferCompression",
        "transferConcurrency",
        "transferChunkKib",
        "transferRequests",
        "transferUploadLimitKib",
        "transferDownloadLimitKib",
      ],
    },
    {
      id: "browsing",
      label: "settings.groups.browsing",
      keys: ["fileIconTheme", "filesShowHidden", "filesFoldersFirst"],
    },
    {
      id: "sorting",
      label: "settings.groups.sorting",
      keys: ["filesSortBy", "filesSortDirection"],
    },
    {
      id: "preloading",
      label: "settings.groups.preloading",
      keys: ["preloadDirs", "preloadCount"],
    },
  ],
};

export function groupSettings(section: SettingsSection, definitions: SettingDefinition[]) {
  const groups = SETTINGS_GROUPS[section] ?? [];
  const groupedKeys = new Set(groups.flatMap((group) => [...group.keys]));
  const ungrouped = definitions.filter((definition) => !groupedKeys.has(definition.key));
  return [
    ...groups.map((group) => ({
      ...group,
      definitions: group.keys.flatMap((key) =>
        definitions.filter((definition) => definition.key === key),
      ),
    })),
    { id: "ungrouped", label: null, definitions: ungrouped, preview: undefined },
  ].filter((group) => group.definitions.length);
}
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
  {
    key: "network",
    section: "network",
    label: "network.title",
    hint: "network.intro",
    kind: "network",
  },
  {
    key: "keyboardShortcuts",
    section: "shortcuts",
    kind: "shortcuts",
    label: "shortcuts.title",
    hint: "shortcuts.hint",
  },
  {
    key: "shortcutRules",
    section: "shortcuts",
    kind: "shortcutRules",
    label: "shortcuts.advanced.title",
  },
  {
    key: "showShortcutDetails",
    section: "shortcuts",
    kind: "shortcutRules",
    label: "shortcuts.advanced.show",
  },
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
  toggle("releaseWebviewInTray", "general", "settings.releaseWebviewInTrayHint"),
  toggle("lightweightMode", "general", "settings.lightweightModeHint"),
  {
    ...toggle("showDockIconInBackground", "general", "settings.showDockIconInBackgroundHint"),
    macOnly: true,
  },
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
  toggle("hostDirectConnect", "workspace", "settings.hostDirectConnectHint"),
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
  toggle("terminalApplicationClipboard", "terminal", "settings.terminalApplicationClipboardHint"),
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
  toggle("transferOptimization", "files", "settings.transferOptimizationHint"),
  {
    ...toggle("transferCompression", "files", "settings.transferCompressionHint"),
    dependsOn: "transferOptimization",
  },
  ...(["transferUploadLimitKib", "transferDownloadLimitKib"] as const).map((key) => ({
    ...numeric(key, "files", 0, 1_048_576, 1, "KiB/s"),
    hint: "settings.transferSpeedLimitHint" as const,
  })),
  ...(
    [
      ["transferConcurrency", [1, 2, 4, 8]],
      ["transferChunkKib", [256, 1024, 4096, 16384]],
      ["transferRequests", [1, 4, 8, 16, 32]],
    ] as const
  ).map(([key, choices]) => ({
    ...select(
      key,
      "files",
      [
        choice(0, "settings.transferAutomatic"),
        ...choices.map((value) => ({
          value,
          label: key === "transferChunkKib" ? `${value} KiB` : String(value),
          literal: true as const,
        })),
      ],
      `settings.${key}Hint`,
    ),
    dependsOn: "transferOptimization" as const,
  })),
  toggle("filesFoldersFirst", "files"),
  {
    key: "fileIconTheme",
    section: "files",
    label: "settings.fileIconTheme",
    hint: "settings.fileIconThemeHint",
    kind: "fileIcons",
  },
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
    ...select("updateCheckInterval", "updates", [
      choice("startup", "updates.onStartup"),
      choice("daily", "updates.daily"),
      choice("weekly", "updates.weekly"),
    ]),
    label: "updates.checkInterval",
    dependsOn: "autoCheckUpdates",
    hint: "updates.checkIntervalHint",
  },
  {
    ...select("updateChannel", "updates", [
      choice("stable", "updates.stable"),
      choice("beta", "updates.beta"),
    ]),
    label: "updates.channel",
    hint: "updates.channelHint",
  },
  {
    ...select("updateSource", "updates", [
      choice("github", "updates.github"),
      choice("custom", "updates.custom"),
    ]),
    label: "updates.source",
    hint: "updates.sourceHint",
  },
  {
    key: "updateSourceUrl",
    section: "updates",
    label: "updates.sourceUrl",
    kind: "updateUrl",
    hint: "updates.sourceUrlHint",
  },
  {
    key: "userCss",
    section: "advanced",
    label: "settings.customCss",
    kind: "css",
    hint: "settings.customCssHint",
  },
];
