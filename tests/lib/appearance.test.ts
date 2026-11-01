// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyAppearance,
  observeSystemAppearance,
  resolveLanguage,
  resolveMotion,
  resolveTheme,
  validateUserCss,
} from "@/lib/prefs/appearance";
import { createDefaultSettings, DEFAULT_SETTINGS } from "@/lib/prefs/defaults";

afterEach(() => vi.restoreAllMocks());

describe("appearance preferences", () => {
  it("uses the platform title bar defaults with system theme, 14px mono and no right panel", () => {
    expect(createDefaultSettings("windows").titleBarStyle).toBe("compact");
    expect(createDefaultSettings("macos").titleBarStyle).toBe("system");
    expect(createDefaultSettings("linux").titleBarStyle).toBe("system");
    expect(DEFAULT_SETTINGS.theme).toBe("system");
    expect(DEFAULT_SETTINGS.monoFontSize).toBe(14);
    expect(DEFAULT_SETTINGS.rightPanel).toBe(false);
  });

  it("resolves system motion and respects explicit full/reduced choices", () => {
    expect(resolveMotion("system", true)).toBe("reduced");
    expect(resolveMotion("system", false)).toBe("full");
    expect(resolveMotion("full", true)).toBe("full");
    expect(resolveMotion("reduced", false)).toBe("reduced");
  });

  it("updates system motion and theme live, and releases OS listeners", () => {
    const theme = Object.assign(new EventTarget(), { matches: false });
    const motion = Object.assign(new EventTarget(), { matches: false });
    vi.spyOn(window, "matchMedia").mockImplementation(
      (query) => (query.includes("reduced-motion") ? motion : theme) as MediaQueryList,
    );
    let settings = { ...DEFAULT_SETTINGS };
    applyAppearance(settings);
    const stop = observeSystemAppearance(() => settings);
    expect(document.documentElement.dataset.motion).toBe("full");
    motion.matches = true;
    motion.dispatchEvent(new Event("change"));
    expect(document.documentElement.dataset.motion).toBe("reduced");
    theme.matches = true;
    theme.dispatchEvent(new Event("change"));
    expect(document.documentElement.dataset.theme).toBe("light");
    settings = { ...settings, motion: "full" };
    applyAppearance(settings);
    motion.dispatchEvent(new Event("change"));
    expect(document.documentElement.dataset.motion).toBe("full");
    expect(document.documentElement.dataset.motionPreference).toBe("full");
    stop();
    settings = { ...settings, motion: "system" };
    motion.dispatchEvent(new Event("change"));
    expect(document.documentElement.dataset.motion).toBe("full");
  });

  it("keeps unchanged user CSS nodes intact during unrelated settings updates", () => {
    const settings = { ...DEFAULT_SETTINGS, userCss: ":root { --custom-token: red; }" };
    applyAppearance(settings);
    const style = document.getElementById("td-user-css")!;
    const observer = new MutationObserver(() => {});
    observer.observe(style, { childList: true, characterData: true, subtree: true });
    applyAppearance({ ...settings, monitorIntervalMs: 10000 });
    expect(document.getElementById("td-user-css")).toBe(style);
    expect(observer.takeRecords()).toHaveLength(0);
    applyAppearance({ ...settings, userCss: ":root { --custom-token: blue; }" });
    expect(observer.takeRecords().length).toBeGreaterThan(0);
    observer.disconnect();
    style.remove();
  });
});

describe("resolveTheme", () => {
  it("follows the system when asked", () => {
    expect(resolveTheme("system", true)).toBe("light");
    expect(resolveTheme("system", false)).toBe("dark");
  });

  it("keeps an explicit choice", () => {
    expect(resolveTheme("dark", true)).toBe("dark");
    expect(resolveTheme("light", false)).toBe("light");
  });
});

describe("resolveLanguage", () => {
  it("detects Chinese locales", () => {
    expect(resolveLanguage("system", "zh-CN")).toBe("zh-CN");
    expect(resolveLanguage("system", "zh-Hant-TW")).toBe("zh-CN");
  });

  it("falls back to English", () => {
    expect(resolveLanguage("system", "de-DE")).toBe("en-US");
    expect(resolveLanguage("system", "en-GB")).toBe("en-US");
  });

  it("prefers the explicit setting", () => {
    expect(resolveLanguage("en-US", "zh-CN")).toBe("en-US");
    expect(resolveLanguage("zh-CN", "en-US")).toBe("zh-CN");
  });

  it("reads the OS language list in order", () => {
    expect(resolveLanguage("system", ["zh-CN", "en-US"])).toBe("zh-CN");
    expect(resolveLanguage("system", ["en-US", "zh-CN"])).toBe("en-US");
    expect(resolveLanguage("system", ["fr-FR", "zh-CN", "en-US"])).toBe("zh-CN");
  });

  it("defaults to English without a usable language", () => {
    expect(resolveLanguage("system", [])).toBe("en-US");
  });
});

describe("validateUserCss", () => {
  it("accepts token overrides", () => {
    expect(validateUserCss(":root { --td-accent: #35e0ff; }").ok).toBe(true);
  });

  it("accepts local data urls", () => {
    expect(validateUserCss(".x { background: url(data:image/png;base64,AAA); }").ok).toBe(true);
  });

  it("rejects imports", () => {
    expect(validateUserCss('@import "theme.css";').reason).toBe("import");
  });

  it("rejects remote urls", () => {
    expect(validateUserCss(".x { background: url(https://example.com/a.png); }").reason).toBe(
      "external",
    );
    expect(validateUserCss(".x { background: url('//cdn.example.com/a.png'); }").reason).toBe(
      "external",
    );
  });
});
