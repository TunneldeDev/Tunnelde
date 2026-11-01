import type { ColorOverrides, ColorRegion, Settings } from "@/lib/api/types";
import { hexToRgb, normalizeHex, rgbToHex } from "./colorMath";

export const COLOR_REGIONS: ColorRegion[] = [
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
export const COLOR_PREVIEW_EVENT = "tunnelde:color-preview";
const variables: Record<ColorRegion, string> = {
  background: "--td-color-background",
  activityBar: "--td-color-activity-bar",
  sidebar: "--td-color-sidebar",
  titleBar: "--td-color-title-bar",
  tabBar: "--td-color-tab-bar",
  editor: "--td-color-editor",
  panel: "--td-color-panel",
  statusBar: "--td-color-status-bar",
  terminalBackground: "--td-color-terminal-background",
  terminalForeground: "--td-color-terminal-foreground",
  terminalCursor: "--td-color-terminal-cursor",
};

const regionSelectors: Partial<Record<ColorRegion, string>> = {
  background: ".workspace, .pane__body, .page, .sftp-pane",
  activityBar: ".activitybar",
  sidebar: ".sidebar-view, .sidebar, .trusted-hosts-sidebar, .plugins-sidebar",
  titleBar: ".window-titlebar, .terminal-head, .editor-head",
  tabBar: ".pane__tabs",
  editor: ".editor-page, .editor-body",
  panel: ".panel",
  statusBar: ".statusbar",
};

function mix(first: string, second: string, amount: number): string {
  const a = hexToRgb(first),
    b = hexToRgb(second);
  return rgbToHex({
    r: a.r + (b.r - a.r) * amount,
    g: a.g + (b.g - a.g) * amount,
    b: a.b + (b.b - a.b) * amount,
  });
}

function luminance(value: string): number {
  const { r, g, b } = hexToRgb(value);
  const linear = (channel: number) => {
    const v = channel / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return linear(r) * 0.2126 + linear(g) * 0.7152 + linear(b) * 0.0722;
}

export function contrastRatio(first: string, second: string): number {
  const a = luminance(first),
    b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function readableTone(source: string, target: string, surfaces: string[], ratio: number): string {
  for (let step = 0; step <= 100; step++) {
    const candidate = mix(source, target, step / 100);
    if (surfaces.every((surface) => contrastRatio(candidate, surface) >= ratio)) return candidate;
  }
  return target;
}

/** Derive a coherent surface palette without changing the global light/dark theme. */
export function deriveRegionPalette(background: string, accent = "#2f6fed") {
  const bg = normalizeHex(background) ?? "#070b12";
  const blackText = contrastRatio(bg, "#000000") >= contrastRatio(bg, "#ffffff");
  const endpoint = blackText ? "#000000" : "#ffffff";
  const preferred = blackText ? "#131a28" : "#e6edf7";
  const text = contrastRatio(bg, preferred) >= 7 ? preferred : endpoint;
  const opposite = blackText ? "#ffffff" : "#000000";
  const surface = (amount: number) => {
    const candidate = mix(bg, text, amount);
    return contrastRatio(candidate, text) >= 4.5 ? candidate : mix(bg, opposite, amount);
  };
  const hover = surface(0.045),
    active = surface(0.08),
    elevated = surface(0.035),
    raised = surface(0.06);
  const surfaces = [bg, hover, active, elevated, raised];
  const readableAccent = readableTone(normalizeHex(accent) ?? "#2f6fed", text, surfaces, 4.5);
  const accentStrong = mix(readableAccent, text, 0.12);
  const accentForeground =
    contrastRatio(readableAccent, "#000000") >= contrastRatio(readableAccent, "#ffffff")
      ? "#000000"
      : "#ffffff";
  return {
    bg,
    panel: bg,
    text,
    muted: readableTone(mix(bg, text, 0.7), text, surfaces, 4.5),
    faint: readableTone(mix(bg, text, 0.5), text, surfaces, 3),
    border: mix(bg, text, 0.18),
    borderStrong: mix(bg, text, 0.3),
    hover,
    active,
    elevated,
    raised,
    accent: readableAccent,
    accentStrong,
    accentSoft: active,
    accentForeground,
    focus: `0 0 0 2px ${readableAccent}`,
  };
}

const paletteVariables: Record<keyof ReturnType<typeof deriveRegionPalette>, string> = {
  bg: "--td-bg",
  panel: "--td-panel",
  text: "--td-text",
  muted: "--td-muted",
  faint: "--td-faint",
  border: "--td-border",
  borderStrong: "--td-border-strong",
  hover: "--td-hover",
  active: "--td-active",
  elevated: "--td-elevated",
  raised: "--td-raised",
  accent: "--td-accent",
  accentStrong: "--td-accent-strong",
  accentSoft: "--td-accent-soft",
  accentForeground: "--td-accent-foreground",
  focus: "--td-focus",
};

function paletteRule(selector: string, palette: ReturnType<typeof deriveRegionPalette>): string {
  return `:where(${selector}){${Object.entries(palette)
    .map(([key, value]) => `${paletteVariables[key as keyof typeof palette]}:${value};`)
    .join("")}}`;
}
type ColorPreferences = Pick<Settings, "accent" | "colors">;
type ColorPreview = { accent?: string; colors?: ColorOverrides };
let saved: ColorPreferences = { accent: "blue", colors: {} };
let preview: ColorPreview | null = null;
let light = false;

export function defaultRegionColor(region: ColorRegion, theme: "light" | "dark"): string {
  if (region === "terminalForeground") return theme === "light" ? "#131a28" : "#e6edf7";
  if (region === "terminalCursor") return theme === "light" ? "#2563eb" : "#35e0ff";
  if (region === "terminalBackground") return theme === "light" ? "#f8fafd" : "#070b12";
  if (["background", "activityBar", "editor"].includes(region))
    return theme === "light" ? "#f2f5fa" : "#070b12";
  return theme === "light" ? "#ffffff" : "#0e1420";
}
export function resolveAccent(value: string, theme: "light" | "dark"): string {
  return (
    normalizeHex(value) ??
    {
      blue: theme === "light" ? "#2563eb" : "#2f6fed",
      cyan: "#17b6d2",
      green: "#2fbd7f",
      orange: "#d99a2b",
      violet: "#7b6bf0",
    }[value] ??
    "#2f6fed"
  );
}
export function effectiveColors(colors: ColorOverrides = {}): ColorOverrides {
  return { ...colors, ...preview?.colors };
}
function renderColors() {
  const root = document.documentElement;
  const colors = effectiveColors(saved.colors);
  const declarations: string[] = [];
  const rules: string[] = [];
  const accent = preview?.accent ?? saved.accent;
  const resolvedAccent = resolveAccent(accent, light ? "light" : "dark");
  for (const region of COLOR_REGIONS) {
    const value = colors[region];
    root.style.removeProperty(variables[region]);
    const normalized = value ? normalizeHex(value) : null;
    if (normalized) {
      declarations.push(`${variables[region]}:${normalized};`);
      const selector = regionSelectors[region];
      if (selector)
        rules.push(paletteRule(selector, deriveRegionPalette(normalized, resolvedAccent)));
    }
  }
  const activeTab = normalizeHex(colors.tabBar ?? "") ?? normalizeHex(colors.background ?? "");
  if (activeTab) {
    const background = colors.tabBar ? deriveRegionPalette(activeTab).raised : activeTab;
    declarations.push(`--td-color-active-tab:${background};`);
    rules.push(paletteRule(".td-tab.is-active", deriveRegionPalette(background, resolvedAccent)));
  }
  root.dataset.accent = accent;
  for (const key of ["--td-accent", "--td-accent-strong", "--td-accent-soft", "--td-focus"])
    root.style.removeProperty(key);
  if (normalizeHex(accent)) {
    const hex = resolveAccent(accent, light ? "light" : "dark");
    const rgb = hexToRgb(hex);
    const target = light ? 0 : 255;
    const strong = rgbToHex({
      r: rgb.r + (target - rgb.r) * 0.15,
      g: rgb.g + (target - rgb.g) * 0.15,
      b: rgb.b + (target - rgb.b) * 0.15,
    });
    declarations.push(
      `--td-accent:${hex};`,
      `--td-accent-strong:${strong};`,
      `--td-accent-soft:rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.16);`,
      `--td-focus:0 0 0 2px rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.45);`,
    );
  }
  // Generated settings use the regular cascade; user CSS remains last and needs no !important.
  let style = document.getElementById("td-color-preferences") as HTMLStyleElement | null;
  if (!declarations.length && !rules.length) {
    style?.remove();
    return;
  }
  if (!style) {
    style = document.createElement("style");
    style.id = "td-color-preferences";
  }
  const css = `:root{${declarations.join("")}}\n${rules.join("\n")}`;
  if (style.textContent !== css) style.textContent = css;
  const user = document.getElementById("td-user-css");
  if (
    !style.isConnected ||
    (user && !(style.compareDocumentPosition(user) & Node.DOCUMENT_POSITION_FOLLOWING))
  )
    document.head.insertBefore(style, user);
}
export function applyColorPreferences(preferences: ColorPreferences, theme: "light" | "dark") {
  saved = preferences;
  light = theme === "light";
  renderColors();
}
/** Ephemeral preview never enters settings, persistence, or session state. */
export function previewColors(next: ColorPreview | null) {
  preview = next;
  renderColors();
  window.dispatchEvent(new Event(COLOR_PREVIEW_EVENT));
}
