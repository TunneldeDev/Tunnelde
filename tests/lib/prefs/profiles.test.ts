import { describe, expect, it } from "vitest";
import { createDefaultSettings } from "@/lib/prefs/defaults";
import { portableSettings, profileMatches, sameSettings } from "@/lib/prefs/profiles";

describe("portable settings snapshots", () => {
  it("only copies explicitly portable preferences and isolates nested objects", () => {
    const settings = {
      ...createDefaultSettings("windows"),
      skippedVersion: "2.0.0",
      lastUpdateCheck: 123,
      showDockIconInBackground: false,
      colors: { background: "#123456" },
      keyboardShortcuts: { "app.settings": ["Mod+Comma"] },
      password: "should never be exported",
      pluginConfig: { token: "private" },
    };
    const snapshot = portableSettings(settings);
    expect(snapshot).not.toHaveProperty("skippedVersion");
    expect(snapshot).not.toHaveProperty("lastUpdateCheck");
    expect(snapshot).not.toHaveProperty("password");
    expect(snapshot).not.toHaveProperty("pluginConfig");
    expect(snapshot.showDockIconInBackground).toBe(false);
    expect(snapshot.keyboardShortcuts).toEqual(settings.keyboardShortcuts);
    snapshot.colors!.background = "#ffffff";
    snapshot.keyboardShortcuts!["app.settings"]!.push("F2");
    expect(settings.colors.background).toBe("#123456");
    expect(settings.keyboardShortcuts["app.settings"]).toEqual(["Mod+Comma"]);
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
