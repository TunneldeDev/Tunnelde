import { beforeEach, expect, it, vi } from "vitest";
import { settingsAllowsMove } from "@/features/settings/window/registration";
const f = vi.hoisted(() => ({
  settings: { uiProviders: {} as Record<string, unknown> },
  provider: null as null | {
    plugin: { id: string; fingerprint: string };
    view: { id: string; allowFloating?: boolean };
  },
  view: vi.fn(),
  isFactoryView: vi.fn(),
}));
vi.mock("@/store/settings", () => ({
  useSettings: { getState: () => ({ settings: f.settings }) },
}));
vi.mock("@/store/plugins", () => ({ usePlugins: { getState: () => ({ items: [] }) } }));
vi.mock("@/lib/extensions/providers", () => ({ selectedUiProvider: () => f.provider }));
vi.mock("@/lib/extensions/frontendRuntime", () => ({
  frontendRuntime: { view: f.view, isFactoryView: f.isFactoryView },
}));
beforeEach(() => {
  f.settings.uiProviders = {};
  f.provider = null;
  f.view.mockReset();
  f.isFactoryView.mockReset();
});
it("admits builtin settings but keeps unavailable selected providers in main", () => {
  expect(settingsAllowsMove()).toBe(true);
  f.settings.uiProviders.preferences = { pluginId: "provider", viewId: "settings" };
  expect(settingsAllowsMove()).toBe(false);
});
it("checks the exact preferences factory renderer rather than sidebar-only factoryOwner", () => {
  f.settings.uiProviders.preferences = { pluginId: "provider", viewId: "settings" };
  f.provider = { plugin: { id: "provider", fingerprint: "current" }, view: { id: "settings" } };
  const View = () => null;
  f.view.mockReturnValue(View);
  f.isFactoryView.mockReturnValue(true);
  expect(settingsAllowsMove()).toBe(true);
  expect(f.view).toHaveBeenCalledWith("provider", "settings", "current");
  expect(f.isFactoryView).toHaveBeenCalledWith("provider", "settings", View);
  f.isFactoryView.mockReturnValue(false);
  expect(settingsAllowsMove()).toBe(false);
  f.isFactoryView.mockReturnValue(true);
  f.provider.view.allowFloating = false;
  expect(settingsAllowsMove()).toBe(false);
  f.provider.view.allowFloating = true;
  f.view.mockReturnValue(undefined);
  expect(settingsAllowsMove()).toBe(false);
});
