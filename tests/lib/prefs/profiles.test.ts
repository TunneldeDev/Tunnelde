import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createDefaultSettings } from "@/lib/prefs/defaults";
import {
  PORTABLE_SETTING_KEYS,
  portableSettings,
  profileMatches,
  sameSettings,
} from "@/lib/prefs/profiles";

describe("portable settings snapshots", () => {
  it("keeps the native profile allowlist identical to the frontend export contract", () => {
    const source = readFileSync(
      "src-tauri/src/settings_profiles.rs",
      "utf8",
    );
    const declaration = source.match(/const PORTABLE_KEYS: &\[&str\] = &\[([\s\S]*?)\];/);
    expect(declaration, "native portable settings declaration").not.toBeNull();
    const keys = [...declaration![1]!.matchAll(/"([A-Za-z]+)"/g)].map((match) => match[1]);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.sort()).toEqual([...PORTABLE_SETTING_KEYS].sort());
    expect(PORTABLE_SETTING_KEYS.every((key) => key in createDefaultSettings())).toBe(true);
  });
  it("only copies explicitly portable preferences and isolates nested objects", () => {
    const settings = {
      ...createDefaultSettings("windows"),
      skippedVersion: "2.0.0",
      lastUpdateCheck: 123,
      showDockIconInBackground: false,
      fileIconTheme: "file-icons:common",
      transferCompression: false,
      colors: { background: "#123456" },
      keyboardShortcuts: { "app.settings": ["Mod+Comma"] },
      shortcutRules: {
        "terminal.paste": { "Mod+V": { priority: 300, propagation: "continue" as const } },
      },
      showShortcutDetails: true,
      password: "should never be exported",
      pluginConfig: { token: "private" },
    };
    const snapshot = portableSettings(settings);
    expect(snapshot).not.toHaveProperty("skippedVersion");
    expect(snapshot).not.toHaveProperty("lastUpdateCheck");
    expect(snapshot).not.toHaveProperty("password");
    expect(snapshot).not.toHaveProperty("pluginConfig");
    expect(snapshot.showDockIconInBackground).toBe(false);
    expect(snapshot.fileIconTheme).toBe("file-icons:common");
    expect(snapshot.transferCompression).toBe(false);
    expect(snapshot.keyboardShortcuts).toEqual(settings.keyboardShortcuts);
    expect(snapshot.shortcutRules).toEqual(settings.shortcutRules);
    expect(snapshot.showShortcutDetails).toBe(true);
    snapshot.shortcutRules!["terminal.paste"]!["Mod+V"]!.priority = 1;
    expect(settings.shortcutRules["terminal.paste"]["Mod+V"].priority).toBe(300);
    snapshot.colors!.background = "#ffffff";
    snapshot.keyboardShortcuts!["app.settings"]!.push("F2");
    expect(settings.colors.background).toBe("#123456");
    expect(settings.keyboardShortcuts["app.settings"]).toEqual(["Mod+Comma"]);
    expect(snapshot.hostList).toEqual(settings.hostList);
    snapshot.hostList!.order.push("plugin/inventory/cost");
    snapshot.hostList!.widths.name = 240;
    expect(settings.hostList.order).not.toContain("plugin/inventory/cost");
    expect(settings.hostList.widths.name).toBeUndefined();
  });

  it("ignores JSON object ordering and runtime changes when matching a profile", () => {
    const settings = createDefaultSettings();
    const snapshot = portableSettings(settings);
    const profile = {
      id: "one",
      name: "Work",
      settings: Object.fromEntries(Object.entries(snapshot).reverse()),
      updatedAt: 0,
    };
    expect(
      profileMatches(profile, { ...settings, lastUpdateCheck: 456, skippedVersion: "2.0" }),
    ).toBe(true);
    expect(profileMatches(profile, { ...settings, monoFontSize: 18 })).toBe(false);
    expect(sameSettings({ "app.settings": [] }, {})).toBe(false);
    expect(sameSettings({ keys: ["F1", "F2"] }, { keys: ["F2", "F1"] })).toBe(false);
  });
});
