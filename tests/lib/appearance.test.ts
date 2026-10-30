// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { describe, expect, it } from "vitest";

import { resolveLanguage, resolveTheme, validateUserCss } from "@/lib/prefs/appearance";

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
