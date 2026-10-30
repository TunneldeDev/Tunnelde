// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import type { Language, MonoFont, Settings, ThemeMode } from "./types";

export type ResolvedTheme = "dark" | "light";
export type ResolvedLanguage = "zh-CN" | "en-US";

/** Font stacks offered for the terminal and every monospace surface. */
export const MONO_STACKS: Record<MonoFont, string> = {
  "fira-code": '"Fira Code", "Cascadia Mono", "JetBrains Mono", ui-monospace, monospace',
  "jetbrains-mono": '"JetBrains Mono", "Fira Code", "Cascadia Mono", ui-monospace, monospace',
  "plex-mono": '"IBM Plex Mono", "Cascadia Mono", "JetBrains Mono", ui-monospace, monospace',
  system: "ui-monospace, SFMono-Regular, Consolas, monospace",
};

export function monoStack(font: MonoFont): string {
  return MONO_STACKS[font] ?? MONO_STACKS["fira-code"];
}


export function resolveTheme(mode: ThemeMode, prefersLight = false): ResolvedTheme {
  if (mode === "system") {
    return prefersLight ? "light" : "dark";
  }
  return mode;
}

export function resolveLanguage(
  setting: Language,
  navigatorLanguage: string | readonly string[] = "en-US",
): ResolvedLanguage {
  if (setting !== "system") {
    return setting;
  }
  const candidates =
    typeof navigatorLanguage === "string" ? [navigatorLanguage] : navigatorLanguage;
  for (const candidate of candidates) {
    const value = candidate.toLowerCase();
    if (value.startsWith("zh")) {
      return "zh-CN";
    }
    if (value.startsWith("en")) {
      return "en-US";
    }
  }
  return "en-US";
}

export function prefersLightScheme(): boolean {
  return (
    typeof window !== "undefined" && !!window.matchMedia?.("(prefers-color-scheme: light)").matches
  );
}

const EXTERNAL_URL = /url\(\s*['"]?(?:https?:)?\/\//i;
const IMPORT_RULE = /@import/i;

export interface CssValidation {
  ok: boolean;
  reason?: "import" | "external";
}

/**
 * The webview CSP already blocks remote assets; this rejects the two patterns
 * that would silently fetch or execute something from another origin.
 */
export function validateUserCss(css: string): CssValidation {
  if (IMPORT_RULE.test(css)) {
    return { ok: false, reason: "import" };
  }
  if (EXTERNAL_URL.test(css)) {
    return { ok: false, reason: "external" };
  }
  return { ok: true };
}

export function applyAppearance(settings: Settings, prefersLight = prefersLightScheme()): void {
  const root = document.documentElement;
  root.dataset.theme = resolveTheme(settings.theme, prefersLight);
  root.dataset.density = settings.density;
  root.dataset.accent = settings.accent;
  root.style.setProperty("--td-font-size", `${settings.uiFontSize}px`);
  root.style.setProperty("--td-mono-size", `${settings.monoFontSize}px`);
  root.style.setProperty("--td-mono", monoStack(settings.monoFont));

  const styleId = "td-user-css";
  let style = document.getElementById(styleId) as HTMLStyleElement | null;
  const css = settings.userCss.trim();
  const valid = css.length > 0 && validateUserCss(css).ok;

  if (!valid) {
    style?.remove();
    return;
  }
  if (!style) {
    style = document.createElement("style");
    style.id = styleId;
    document.head.appendChild(style);
  }
  style.textContent = css;
}
