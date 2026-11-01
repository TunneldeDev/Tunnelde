import { describe, expect, it } from "vitest";
import type { PluginTheme } from "@/lib/api/types";
import { createDefaultSettings } from "@/lib/prefs/defaults";
import { COLOR_REGIONS } from "@/lib/prefs/colors";
import { BUILTIN_THEMES, isThemeActive, themePatch, themeSwatches } from "@/lib/prefs/themes";

const defaults = createDefaultSettings("windows");
const plugin: PluginTheme = {
  id: "moon",
  name: "Moon",
  appearance: "dark",
  colors: { sidebar: "#112233" },
};

describe("theme snapshots", () => {
  it("provides seven distinct complete choices, with system inheriting platform defaults", () => {
    expect(BUILTIN_THEMES).toHaveLength(7);
    expect(themePatch(BUILTIN_THEMES[0]!)).toEqual({ theme: "system", accent: "blue", colors: {} });
    for (const preset of BUILTIN_THEMES) {
      const saved = { ...defaults, ...themePatch(preset) };
      expect(BUILTIN_THEMES.filter((other) => isThemeActive(other, saved))).toEqual([preset]);
      if (!["system", "light", "dark"].includes(preset.id))
        expect(Object.keys(preset.colors).sort()).toEqual([...COLOR_REGIONS].sort());
    }
  });

  it("replaces previous overrides and clones the plugin map", () => {
    const patch = themePatch(plugin);
    expect(patch).toEqual({ theme: "dark", accent: "blue", colors: { sidebar: "#112233" } });
    patch.colors.sidebar = "#ffffff";
    expect(plugin.colors.sidebar).toBe("#112233");
  });

  it("matches an exact snapshot independently of object key order", () => {
    const preset = { ...plugin, colors: { sidebar: "#112233", editor: "#223344" } };
    const settings = {
      ...defaults,
      ...themePatch(preset),
      colors: { editor: "#223344", sidebar: "#112233" },
    };
    expect(isThemeActive(preset, settings)).toBe(true);
    expect(
      isThemeActive(preset, { ...settings, colors: { ...settings.colors, panel: "#223344" } }),
    ).toBe(false);
    expect(isThemeActive(preset, { ...settings, accent: "cyan" })).toBe(false);
    expect(isThemeActive(preset, { ...settings, theme: "system" })).toBe(false);
    expect(isThemeActive(preset, { ...settings, colors: { sidebar: "#112233" } })).toBe(false);
  });

  it("uses resolved system defaults and safe normalized preview colors", () => {
    expect(themeSwatches(BUILTIN_THEMES[0]!, "light")).toEqual([
      "#f2f5fa",
      "#ffffff",
      "#f2f5fa",
      "#2563eb",
    ]);
    const swatches = themeSwatches({
      ...plugin,
      colors: { background: "url(unsafe)", sidebar: "#ABC" },
    });
    expect(swatches[0]).toBe("#070b12");
    expect(swatches[1]).toBe("#aabbcc");
    expect(swatches.every((color) => /^#[\da-f]{6}$/.test(color))).toBe(true);
  });
});
