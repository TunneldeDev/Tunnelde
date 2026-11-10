import { act, fireEvent, render, screen } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import "@/i18n/i18n";
import { PreferenceSurface } from "@/features/settings/components/PreferenceSurface";
import { SettingsPage } from "@/features/settings/SettingsPage";
import { frontendRuntime } from "@/lib/extensions/frontendRuntime";
import { uiProviders } from "@/lib/extensions/providers";
import type {
  FrontendPreferences,
  FrontendViewProps,
  PreferenceSnapshot,
} from "@/lib/extensions/uiSdkContract";
import type { PluginInfo } from "@/lib/api/types";
import { usePlugins } from "@/store/plugins";
import { useSettings } from "@/store/settings";
import { DEFAULT_SETTINGS } from "@/lib/prefs/defaults";
import { usePluginSecurity } from "@/store/pluginSecurity";
import { useNavigation } from "@/store/navigation";

vi.mock("@/features/terminal/TerminalPreview", () => ({ TerminalPreview: () => null }));
const permissions = ["ui.trusted", "settings.read", "settings.write"];
const plugin = {
  id: "preferences-ui",
  name: "Preferences UI",
  version: "1.0.0",
  description: null,
  error: null,
  fingerprint: "first",
  apiVersion: 1,
  path: "/isolated-preferences-ui",
  runtime: "frontend",
  status: "running",
  permissions,
  frontend: { entry: "ui/index.mjs", sdk: "^0.1.0" },
  commands: [],
  views: [{ id: "form", title: "Preferences", kind: "component", provider: "preferences" }],
} as PluginInfo;
const selection = { preferences: { pluginId: plugin.id, viewId: "form" } };
let retained: FrontendPreferences,
  omit = false;
function Provider({ preferences }: FrontendViewProps) {
  useLayoutEffect(() => {
    retained = preferences!;
  });
  const Fields = preferences!.Fields;
  return <section aria-label="custom preferences">{omit ? "Fields omitted" : <Fields />}</section>;
}
const fields = [
  { id: "appearance.theme", label: "Theme", description: "Appearance", modified: false },
];
function Fixture({ query = "", visible = true }: { query?: string; visible?: boolean }) {
  return (
    <PreferenceSurface
      section="appearance"
      query={query}
      modifiedOnly={false}
      fields={fields}
      visible={visible}
    >
      <textarea aria-label="Unsaved preference" defaultValue="draft" />
    </PreferenceSurface>
  );
}
beforeEach(() => {
  omit = false;
  useSettings.setState({
    settings: { ...DEFAULT_SETTINGS, uiProviders: selection },
    saving: false,
    error: null,
    update: vi.fn(async (patch) => {
      useSettings.setState((state) => ({ settings: { ...state.settings, ...patch } }));
      return true;
    }),
  });
  useNavigation.setState({ settingsSection: "general" });
  usePlugins.setState({ items: [plugin] });
  usePluginSecurity.setState((state) => ({
    state: { ...state.state, restricted: false, grants: { [plugin.id]: permissions } },
  }));
  vi.spyOn(frontendRuntime, "view").mockReturnValue(Provider);
  vi.spyOn(frontendRuntime, "token").mockReturnValue("token");
  vi.spyOn(frontendRuntime, "call").mockResolvedValue({
    version: 1,
    revision: "durable",
    values: {},
    defaults: {},
  });
});

it("selects nothing implicitly and retains the same native field and draft across selection and restoration", async () => {
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, uiProviders: {} } });
  render(<Fixture />);
  const input = screen.getByRole("textbox", { name: "Unsaved preference" });
  fireEvent.change(input, { target: { value: "unfinished" } });
  expect(screen.queryByRole("region", { name: "custom preferences" })).toBeNull();
  act(() =>
    useSettings.setState((state) => ({ settings: { ...state.settings, uiProviders: selection } })),
  );
  expect(screen.getByRole("region", { name: "custom preferences" }).contains(input)).toBe(true);
  const old = retained;
  fireEvent.click(screen.getByRole("button", { name: "Restore built-in interface" }));
  expect(screen.getByRole("textbox", { name: "Unsaved preference" })).toBe(input);
  expect((input as HTMLTextAreaElement).value).toBe("unfinished");
  await expect(old.read()).rejects.toThrow("viewUnavailable");
});

it("rejects obsolete page frames after query, settings and visibility changes", async () => {
  const view = render(<Fixture />);
  const old = retained;
  view.rerender(<Fixture query="@is:modified" />);
  await expect(old.read()).rejects.toThrow("changed");
  const next = retained;
  act(() => useSettings.setState((state) => ({ settings: { ...state.settings, theme: "light" } })));
  await expect(next.schema()).rejects.toThrow("changed");
  view.rerender(<Fixture visible={false} />);
  await expect(
    retained.update({ revision: "durable", changes: { appearance: { theme: "dark" } } }),
  ).rejects.toThrow("changed");
  expect(frontendRuntime.call).not.toHaveBeenCalled();
});

it("uses the existing authorized transport, detaches snapshots and returns a committed write after its own refresh", async () => {
  render(<Fixture />);
  const result = {
    version: 1,
    revision: "durable",
    values: { appearance: { theme: "dark" } },
    defaults: {},
  };
  vi.mocked(frontendRuntime.call).mockResolvedValue(result);
  const snapshot = await retained.read();
  expect(frontendRuntime.call).toHaveBeenCalledWith(
    plugin.id,
    "token",
    "preferences.snapshot",
    undefined,
  );
  expect(snapshot).not.toBe(result);
  expect(Object.isFrozen(snapshot.values.appearance)).toBe(true);
  vi.mocked(frontendRuntime.call).mockImplementation(async () => {
    await act(async () =>
      useSettings.setState((state) => ({ settings: { ...state.settings, theme: "light" } })),
    );
    return result as unknown as PreferenceSnapshot;
  });
  await expect(
    retained.update({ revision: "durable", changes: { appearance: { theme: "light" } } }),
  ).resolves.toEqual(result);
});

it("rejects asynchronous read results after navigation and does not retry stale persistent writes", async () => {
  const view = render(<Fixture />);
  let finish!: (value: unknown) => void;
  vi.mocked(frontendRuntime.call).mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = retained.read();
  const rejected = expect(pending).rejects.toThrow("changed");
  view.rerender(<Fixture query="changed" />);
  finish({});
  await rejected;
  vi.mocked(frontendRuntime.call).mockRejectedValue(Error("preferences.staleRevision"));
  await expect(retained.update({ revision: "old", changes: {} })).rejects.toThrow("staleRevision");
  expect(frontendRuntime.call).toHaveBeenCalledTimes(2);
});

it("requires live write permission and retires contexts on selection ABA and restriction", async () => {
  usePlugins.setState({
    items: [{ ...plugin, permissions: permissions.filter((p) => p !== "settings.write") }],
  });
  render(<Fixture />);
  expect(retained.capabilities.update).toBe(false);
  await expect(retained.update({ revision: "r", changes: {} })).rejects.toThrow("permissionDenied");
  const old = retained;
  act(() => {
    useSettings.setState((state) => ({ settings: { ...state.settings, uiProviders: {} } }));
    useSettings.setState((state) => ({ settings: { ...state.settings, uiProviders: selection } }));
  });
  await expect(old.read()).rejects.toThrow("viewUnavailable");
  const active = retained;
  act(() =>
    usePluginSecurity.setState((state) => ({ state: { ...state.state, restricted: true } })),
  );
  expect(screen.getByRole("textbox", { name: "Unsaved preference" })).toBeTruthy();
  await expect(active.read()).rejects.toThrow("viewUnavailable");
  expect(uiProviders([{ ...plugin, permissions: ["ui.trusted"] }], "preferences")).toEqual([]);
});

it("keeps native discovery, profiles and restoration when a provider omits Fields", () => {
  omit = true;
  render(<SettingsPage />);
  expect(screen.getByText("Fields omitted")).toBeTruthy();
  expect(screen.getByRole("textbox", { name: "Search settings" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Filter presets" })).toBeTruthy();
  expect(screen.getByRole("navigation", { name: "Settings" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Restore built-in interface" })).toBeTruthy();
  expect(retained.snapshot.fields.every((field) => /^[a-z]+\.[A-Za-z]+$/.test(field.id))).toBe(
    true,
  );
  expect(retained.snapshot.fields.some((field) => field.id.includes("uiProviders"))).toBe(false);
});

it("retains number drafts in the actual settings form when the plugin stops", () => {
  useNavigation.setState({ settingsSection: "appearance" });
  render(<SettingsPage />);
  const input = document.querySelector<HTMLInputElement>('[data-setting="uiFontSize"] input')!;
  expect(input).toBeTruthy();
  fireEvent.change(input, { target: { value: "17" } });
  act(() => usePlugins.setState({ items: [{ ...plugin, status: "stopped" }] }));
  expect(document.querySelector('[data-setting="uiFontSize"] input')).toBe(input);
  expect(input.value).toBe("17");
});

it("restores native controls and preserves drafts on a renderer crash or duplicate Fields", () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  const view = render(<Fixture />);
  const input = screen.getByRole("textbox", { name: "Unsaved preference" });
  fireEvent.change(input, { target: { value: "keep me" } });
  vi.mocked(frontendRuntime.view).mockReturnValue(({ preferences }) => {
    const Fields = preferences!.Fields;
    return (
      <>
        <Fields />
        <Fields />
      </>
    );
  });
  view.rerender(<Fixture query="duplicate" />);
  expect(screen.getByRole("textbox", { name: "Unsaved preference" })).toBe(input);
  expect((input as HTMLTextAreaElement).value).toBe("keep me");
  expect(screen.getByRole("alert")).toBeTruthy();
});
