import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hexToRgb, hsvToRgb, normalizeHex, rgbToHex, rgbToHsv } from "@/lib/prefs/colorMath";
import {
  applyColorPreferences,
  COLOR_PREVIEW_EVENT,
  contrastRatio,
  deriveRegionPalette,
  effectiveColors,
  previewColors,
} from "@/lib/prefs/colors";
import { terminalTheme } from "@/features/terminal/terminalTheme";

beforeEach(() => {
  previewColors(null);
  applyColorPreferences({ accent: "blue", colors: {} }, "dark");
});
afterEach(() => {
  previewColors(null);
  applyColorPreferences({ accent: "blue", colors: {} }, "dark");
});

describe("color math", () => {
  it("normalizes complete HEX values and rejects partial or unsupported input", () => {
    expect(normalizeHex("  AbC ")).toBe("#aabbcc");
    expect(normalizeHex("#12EFa0")).toBe("#12efa0");
    for (const input of ["", "#", "#12", "#1234", "#12345678", "red", "#gggggg"])
      expect(normalizeHex(input)).toBeNull();
    expect(rgbToHex({ r: -1, g: 128.6, b: 300 })).toBe("#0081ff");
  });

  it("round trips RGB through HSV including black, gray and every hue sector", () => {
    for (const r of [0, 17, 128, 255])
      for (const g of [0, 17, 128, 255])
        for (const b of [0, 17, 128, 255]) {
          const rgb = { r, g, b };
          expect(hsvToRgb(rgbToHsv(rgb))).toEqual(rgb);
          expect(hexToRgb(rgbToHex(rgb))).toEqual(rgb);
        }
    expect(hsvToRgb({ h: 360, s: 1, v: 1 })).toEqual({ r: 255, g: 0, b: 0 });
    expect(hsvToRgb({ h: -120, s: 2, v: 1 })).toEqual({ r: 0, g: 0, b: 255 });
  });
});

describe("saved and preview colors", () => {
  const style = {
    getPropertyValue: (name: string) =>
      getComputedStyle(document.documentElement).getPropertyValue(name).trim(),
  };

  it("shares overrides across themes and restores theme inheritance when reset", () => {
    const preferences = { accent: "#12EFa0", colors: { sidebar: "#123456" } };
    applyColorPreferences(preferences, "dark");
    expect(style.getPropertyValue("--td-accent")).toBe("#12efa0");
    expect(style.getPropertyValue("--td-color-sidebar")).toBe("#123456");
    applyColorPreferences(preferences, "light");
    expect(style.getPropertyValue("--td-accent")).toBe("#12efa0");
    expect(style.getPropertyValue("--td-color-sidebar")).toBe("#123456");
    applyColorPreferences({ accent: "blue", colors: {} }, "light");
    expect(style.getPropertyValue("--td-accent")).toBe("");
    expect(style.getPropertyValue("--td-color-sidebar")).toBe("");
  });

  it("cancels to the latest saved preferences after another settings update", () => {
    const onPreview = vi.fn();
    window.addEventListener(COLOR_PREVIEW_EVENT, onPreview);
    applyColorPreferences({ accent: "blue", colors: { sidebar: "#112233" } }, "dark");
    previewColors({ accent: "#aabbcc", colors: { sidebar: "#445566" } });
    expect(style.getPropertyValue("--td-color-sidebar")).toBe("#445566");
    applyColorPreferences(
      { accent: "#abcdef", colors: { sidebar: "#778899", editor: "#102030" } },
      "light",
    );
    expect(style.getPropertyValue("--td-color-sidebar")).toBe("#445566");
    expect(style.getPropertyValue("--td-color-editor")).toBe("#102030");
    previewColors(null);
    expect(style.getPropertyValue("--td-color-sidebar")).toBe("#778899");
    expect(style.getPropertyValue("--td-accent")).toBe("#abcdef");
    expect(effectiveColors({ terminalCursor: "#012345" })).toEqual({ terminalCursor: "#012345" });
    expect(onPreview).toHaveBeenCalledTimes(2);
    window.removeEventListener(COLOR_PREVIEW_EVENT, onPreview);
  });

  it("previews accent presets through the existing theme palette and restores the saved preset", () => {
    applyColorPreferences({ accent: "green", colors: {} }, "light");
    previewColors({ accent: "blue" });
    expect(document.documentElement.dataset.accent).toBe("blue");
    expect(style.getPropertyValue("--td-accent")).toBe("");
    expect(style.getPropertyValue("--td-accent-strong")).toBe("");
    previewColors(null);
    expect(document.documentElement.dataset.accent).toBe("green");
    expect(style.getPropertyValue("--td-accent")).toBe("");
  });

  it("preserves ANSI palettes while overriding terminal surfaces and previewing", () => {
    const defaults = terminalTheme("dark");
    const colors = {
      terminalBackground: "#112233",
      terminalForeground: "#ddeeff",
      terminalCursor: "#ffaa22",
    };
    const custom = terminalTheme("dark", colors);
    expect(custom).toEqual({
      ...defaults,
      background: "#112233",
      cursorAccent: "#112233",
      foreground: "#ddeeff",
      cursor: "#ffaa22",
    });
    previewColors({ colors: { terminalBackground: "#445566" } });
    expect(terminalTheme("light", colors).background).toBe("#445566");
    previewColors(null);
    expect(terminalTheme("light", colors).background).toBe("#112233");
  });
});

describe("region contrast and isolation", () => {
  it("themes the global popup palette with the workbench background and restores it after previews and resets", () => {
    const root = () => getComputedStyle(document.documentElement);
    applyColorPreferences({ accent: "#a8b2c1", colors: { background: "#1e1e1e" } }, "dark");
    expect(root().getPropertyValue("--td-bg")).toBe("#1e1e1e");
    expect(root().getPropertyValue("--td-elevated")).toBe(
      deriveRegionPalette("#1e1e1e", "#a8b2c1").elevated,
    );
    previewColors({ colors: { background: "#ffffff" } });
    expect(root().getPropertyValue("--td-scheme")).toBe("light");
    expect(root().getPropertyValue("--td-bg")).toBe("#ffffff");
    previewColors(null);
    expect(root().getPropertyValue("--td-scheme")).toBe("dark");
    expect(root().getPropertyValue("--td-bg")).toBe("#1e1e1e");
    applyColorPreferences({ accent: "blue", colors: { sidebar: "#ffffff" } }, "dark");
    expect(root().getPropertyValue("--td-bg")).toBe("");
    expect(root().getPropertyValue("--td-elevated")).toBe("");
    expect(root().getPropertyValue("--td-scheme")).toBe("");
  });

  it.each(["#ffffff", "#000000", "#777777", "#888888", "#ff0000", "#0000ff", "#33cc99"])(
    "derives readable text, accents and controls for %s",
    (background) => {
      const palette = deriveRegionPalette(background, "#ffff00");
      for (const surface of [
        palette.bg,
        palette.panel,
        palette.hover,
        palette.active,
        palette.elevated,
        palette.raised,
      ]) {
        expect(contrastRatio(palette.text, surface)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(palette.muted, surface)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(palette.faint, surface)).toBeGreaterThanOrEqual(3);
        expect(contrastRatio(palette.accent, surface)).toBeGreaterThanOrEqual(4.5);
      }
      expect(contrastRatio(palette.accent, palette.accentForeground)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(palette.accentStrong, palette.accentForeground)).toBeGreaterThanOrEqual(
        4.5,
      );
      expect(palette.border).not.toBe(palette.bg);
      expect(palette.borderStrong).not.toBe(palette.border);
    },
  );

  it("keeps every gray background legible around the light/dark crossover", () => {
    for (let value = 0; value <= 255; value++) {
      const hex = value.toString(16).padStart(2, "0");
      const palette = deriveRegionPalette(`#${hex}${hex}${hex}`);
      expect(contrastRatio(palette.text, palette.bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(palette.muted, palette.active)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("scopes derived colors to their region, including active tabs, without recoloring dialogs", () => {
    const host = document.createElement("div");
    host.innerHTML =
      '<div class="app"><div class="sidebar">Sidebar</div><div class="pane__tabs"><div class="td-tab is-active">Tab</div></div><div class="td-dialog">Dialog</div></div>';
    document.body.append(host);
    applyColorPreferences(
      { accent: "blue", colors: { sidebar: "#ffffff", tabBar: "#000000" } },
      "dark",
    );
    const sidebar = host.querySelector<HTMLElement>(".sidebar")!;
    const tab = host.querySelector<HTMLElement>(".td-tab")!;
    expect(getComputedStyle(sidebar).getPropertyValue("--td-text")).toBe(
      deriveRegionPalette("#ffffff").text,
    );
    expect(getComputedStyle(tab).getPropertyValue("--td-text")).toBe(
      deriveRegionPalette(deriveRegionPalette("#000000").raised).text,
    );
    expect(getComputedStyle(host.querySelector(".td-dialog")!).getPropertyValue("--td-text")).toBe(
      "",
    );
    expect(document.documentElement.style.getPropertyValue("--td-color-sidebar")).toBe("");
    host.remove();
  });

  it("keeps generated settings before user CSS so root and region overrides win without important", () => {
    const user = document.createElement("style");
    user.id = "td-user-css";
    user.textContent = ":root{--td-color-sidebar:#abcdef}.sidebar{--td-text:#123456}";
    const sidebar = document.createElement("div");
    sidebar.className = "sidebar";
    document.body.append(sidebar);
    applyColorPreferences({ accent: "blue", colors: { sidebar: "#ffffff" } }, "dark");
    document.head.append(user);
    expect(getComputedStyle(document.documentElement).getPropertyValue("--td-color-sidebar")).toBe(
      "#abcdef",
    );
    expect(getComputedStyle(sidebar).getPropertyValue("--td-text")).toBe("#123456");
    const generated = document.getElementById("td-color-preferences")!;
    expect(generated.compareDocumentPosition(user) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    previewColors({ colors: { sidebar: "#000000" } });
    // jsdom registers updated styles by insertion history; browsers use this DOM order.
    expect(generated.compareDocumentPosition(user) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    user.remove();
    sidebar.remove();
  });

  it.each(["light", "dark"] as const)(
    "adjusts terminal foreground and default cursor on custom backgrounds in %s theme without changing ANSI",
    (theme) => {
      const defaults = terminalTheme(theme);
      for (const background of ["#ffffff", "#000000", "#777777"]) {
        const custom = terminalTheme(theme, { terminalBackground: background });
        expect(contrastRatio(custom.foreground!, background)).toBeGreaterThanOrEqual(4.5);
        expect(contrastRatio(custom.cursor!, background)).toBeGreaterThanOrEqual(4.5);
        for (const key of [
          "black",
          "red",
          "green",
          "yellow",
          "blue",
          "magenta",
          "cyan",
          "white",
          "brightBlack",
          "brightRed",
          "brightGreen",
          "brightYellow",
          "brightBlue",
          "brightMagenta",
          "brightCyan",
          "brightWhite",
        ] as const)
          expect(custom[key]).toBe(defaults[key]);
        const explicit = terminalTheme(theme, {
          terminalBackground: background,
          terminalForeground: "#112233",
          terminalCursor: "#aabbcc",
        });
        expect(explicit.foreground).toBe("#112233");
        expect(explicit.cursor).toBe("#aabbcc");
      }
    },
  );
});
