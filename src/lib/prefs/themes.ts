import type { ColorOverrides, Settings } from "@/lib/api/types";
import { normalizeHex } from "./colorMath";
import { defaultRegionColor, resolveAccent } from "./colors";

export interface ThemeDefinition {
  appearance: Settings["theme"];
  accent?: string;
  colors: ColorOverrides;
}

export interface BuiltinTheme extends ThemeDefinition {
  id: "system" | "dark" | "light" | "graphite" | "ocean" | "forest" | "paper";
}

function palette(
  background: string,
  surface: string,
  raised: string,
  foreground: string,
  cursor: string,
): ColorOverrides {
  return {
    background,
    activityBar: surface,
    sidebar: surface,
    titleBar: surface,
    tabBar: surface,
    editor: background,
    panel: raised,
    statusBar: surface,
    terminalBackground: background,
    terminalForeground: foreground,
    terminalCursor: cursor,
  };
}

export const BUILTIN_THEMES: readonly BuiltinTheme[] = [
  { id: "system", appearance: "system", colors: {} },
  { id: "dark", appearance: "dark", colors: {} },
  { id: "light", appearance: "light", colors: {} },
  {
    id: "graphite",
    appearance: "dark",
    accent: "#a8b2c1",
    colors: palette("#1e1e1e", "#252526", "#2d2d30", "#d4d4d4", "#aeafad"),
  },
  {
    id: "ocean",
    appearance: "dark",
    accent: "#59b8d4",
    colors: palette("#0d1b2a", "#142638", "#1b3045", "#d6e6f2", "#7fd4eb"),
  },
  {
    id: "forest",
    appearance: "dark",
    accent: "#84bd95",
    colors: palette("#14201b", "#1c2b23", "#25352c", "#dce8de", "#a0d5a9"),
  },
  {
    id: "paper",
    appearance: "light",
    accent: "#8b6344",
    colors: palette("#f6f2e9", "#ece6d9", "#fffaf0", "#34302a", "#94643d"),
  },
];

/** A theme replaces the saved color snapshot instead of merging with previous overrides. */
export function themePatch(theme: ThemeDefinition): Pick<Settings, "theme" | "accent" | "colors"> {
  return {
    theme: theme.appearance,
    accent: theme.accent ?? "blue",
    colors: { ...theme.colors },
  };
}

export function isThemeActive(theme: ThemeDefinition, settings: Settings): boolean {
  if (settings.theme !== theme.appearance || settings.accent !== (theme.accent ?? "blue"))
    return false;
  const current = Object.entries(settings.colors);
  const expected = Object.entries(theme.colors);
  return (
    current.length === expected.length &&
    expected.every(([key, value]) => settings.colors[key as keyof ColorOverrides] === value)
  );
}

/** Preview values only accept hex colors; plugin strings never become arbitrary CSS. */
export function themeSwatches(theme: ThemeDefinition, system: "light" | "dark" = "dark"): string[] {
  const appearance = theme.appearance === "system" ? system : theme.appearance;
  return [
    normalizeHex(theme.colors.background ?? "") ?? defaultRegionColor("background", appearance),
    normalizeHex(theme.colors.sidebar ?? "") ?? defaultRegionColor("sidebar", appearance),
    normalizeHex(theme.colors.editor ?? "") ?? defaultRegionColor("editor", appearance),
    resolveAccent(theme.accent ?? "blue", appearance),
  ];
}
