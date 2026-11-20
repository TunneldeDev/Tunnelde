import { expect, it } from "vitest";
import { DEFAULT_SETTINGS } from "@/lib/prefs/defaults";
import {
  terminalPreferenceKeys,
  terminalPreferenceProjection,
} from "@/features/terminal/terminalViewServices";

it("projects only terminal display/input preferences, never full writable host settings", () => {
  const settings = {
    ...DEFAULT_SETTINGS,
    unrelatedCredential: "must-not-leave-main",
    pluginGrants: ["all"],
  };
  const projected = terminalPreferenceProjection(settings);
  expect(Object.keys(projected)).toEqual([...terminalPreferenceKeys]);
  expect(projected).not.toHaveProperty("unrelatedCredential");
  expect(projected).not.toHaveProperty("pluginGrants");
  expect(projected).not.toHaveProperty("uiProviders");
  expect(projected).not.toHaveProperty("proxyProfiles");
  expect(projected.monoFont).toBe(settings.monoFont);
  expect(projected.terminalScrollback).toBe(settings.terminalScrollback);
});
