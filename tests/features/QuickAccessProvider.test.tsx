import { mockCommittedViewScopes } from "../fixtures/viewScopes";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import "@/i18n/i18n";
import { CommandPalette } from "@/components/layout/CommandPalette";
import { frontendRuntime } from "@/lib/extensions/frontendRuntime";
import { uiProviders } from "@/lib/extensions/providers";
import type { FrontendQuickAccess, FrontendViewProps } from "@/lib/extensions/uiSdkContract";
import type { PluginInfo } from "@/lib/api/types";
import { usePlugins } from "@/store/plugins";
import { useSettings } from "@/store/settings";
import { DEFAULT_SETTINGS } from "@/lib/prefs/defaults";
import { usePluginSecurity } from "@/store/pluginSecurity";
import { useQuickAccess } from "@/store/quickAccess";
import { useWorkspace } from "@/store/workspace";
import { useEditors } from "@/store/editors";
import { useHosts } from "@/store/hosts";
import { useSsh } from "@/store/ssh";
import { useSearchRoots } from "@/store/searchRoots";

const permissions = [
  "ui.trusted",
  "hosts.read",
  "sessions.read",
  "fs.read",
  "sftp.read",
  "workspace.read",
  "editor.read",
];
const plugin = {
  id: "search-ui",
  name: "Search UI",
  version: "1.0.0",
  fingerprint: "first",
  apiVersion: 1,
  description: null,
  error: null,
  path: "/isolated-search-ui",
  runtime: "frontend",
  status: "running",
  permissions,
  frontend: { entry: "ui/index.mjs", sdk: "^0.1.0" },
  commands: [],
  views: [{ id: "search", title: "Search", kind: "component", provider: "quickAccess" }],
} as PluginInfo;
const selection = { quickAccess: { pluginId: plugin.id, viewId: "search" } };
let retained: FrontendQuickAccess,
  omit = false;
function Provider({ quickAccess }: FrontendViewProps) {
  useLayoutEffect(() => {
    retained = quickAccess!;
  });
  const Entries = quickAccess!.Entries;
  return <section aria-label="custom search">{omit ? "Entries omitted" : <Entries />}</section>;
}
beforeEach(() => {
  mockCommittedViewScopes();
  omit = false;
  useSettings.setState({
    settings: { ...DEFAULT_SETTINGS, uiProviders: selection },
    update: vi.fn(async (patch) => {
      useSettings.setState((state) => ({ settings: { ...state.settings, ...patch } }));
      return true;
    }),
  });
  usePlugins.setState({ items: [plugin] });
  useHosts.setState({ hosts: [] });
  useEditors.setState({ entries: {} });
  useSearchRoots.setState({ roots: {} });
  useSsh.setState({ sessions: [] });
  useWorkspace.setState({ tabs: [], activeId: null });
  usePluginSecurity.setState((state) => ({
    state: { ...state.state, restricted: false, grants: { [plugin.id]: permissions } },
  }));
  useQuickAccess.getState().show(">welcome");
  vi.spyOn(frontendRuntime, "view").mockReturnValue(Provider);
  vi.spyOn(frontendRuntime, "token").mockReturnValue("token");
});

it("composes the same native option and restores without replacing its DOM", () => {
  render(<CommandPalette />);
  const row = screen.getByRole("option", { name: /Welcome/ });
  expect(screen.getByRole("region", { name: "custom search" }).contains(row)).toBe(true);
  const old = retained;
  fireEvent.click(screen.getByRole("button", { name: "Restore built-in interface" }));
  expect(screen.getByRole("option", { name: /Welcome/ })).toBe(row);
  expect(() => old.read({ revision: old.snapshot.revision })).toThrow("viewUnavailable");
});
it("keeps input, presets, escape and native keyboard invocation when Entries are omitted", () => {
  omit = true;
  render(<CommandPalette />);
  expect(screen.getByText("Entries omitted")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Filter presets" })).toBeTruthy();
  const input = screen.getByRole("combobox");
  fireEvent.change(input, { target: { value: ">settings" } });
  expect(retained.snapshot.query).toBe(">settings");
  fireEvent.keyDown(input, { key: "Enter" });
  expect(useWorkspace.getState().tabs.some((tab) => tab.kind === "settings")).toBe(true);
});
it("returns focus to the query when pagination controls disappear", () => {
  useQuickAccess.getState().show(">");
  usePlugins.setState({
    items: [
      plugin,
      {
        ...plugin,
        id: "batch",
        name: "Batch",
        views: [],
        commands: Array.from({ length: 150 }, (_, index) => ({
          id: `cmd${index}`,
          title: `Item ${index}`,
        })),
      },
    ],
  });
  render(<CommandPalette />);
  const next = screen.getByRole("button", { name: "Next page" });
  next.focus();
  fireEvent.click(next);
  act(() => retained.setQuery(">welcome"));
  expect(document.activeElement).toBe(screen.getByRole("combobox"));
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
});
it("requires write permission for provider invocation and live frames for mutations", () => {
  render(<CommandPalette />);
  const old = retained;
  expect(old.capabilities.invoke).toBe(false);
  expect(() => old.invoke({ revision: old.snapshot.revision, key: "result:0" })).toThrow(
    "permissionDenied",
  );
  act(() => retained.setQuery(">settings"));
  expect(() => old.setQuery(">restart")).toThrow("changed");
  act(() =>
    usePlugins.setState({
      items: [{ ...plugin, permissions: [...permissions, "workspace.write"] }],
    }),
  );
  act(() => retained.invoke({ revision: retained.snapshot.revision, key: "result:0" }));
  expect(useWorkspace.getState().tabs.some((tab) => tab.kind === "settings")).toBe(true);
});
it("retires a selected provider across batched selection ABA, revocation and close", () => {
  render(<CommandPalette />);
  const old = retained;
  act(() => {
    useSettings.setState((state) => ({ settings: { ...state.settings, uiProviders: {} } }));
    useSettings.setState((state) => ({ settings: { ...state.settings, uiProviders: selection } }));
  });
  expect(() => old.setQuery(">restart")).toThrow("viewUnavailable");
  const current = retained;
  act(() =>
    usePluginSecurity.setState((state) => ({ state: { ...state.state, restricted: true } })),
  );
  expect(screen.getByRole("option", { name: /Welcome/ })).toBeTruthy();
  expect(() => current.close()).toThrow("viewUnavailable");
  act(() => useQuickAccess.getState().close());
  expect(screen.queryByRole("dialog")).toBeNull();
});
it("falls back on duplicate native Entries and keeps the host dismissal control", () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(frontendRuntime.view).mockReturnValue(({ quickAccess }) => {
    const Entries = quickAccess!.Entries;
    return (
      <>
        <Entries />
        <Entries />
      </>
    );
  });
  render(<CommandPalette />);
  expect(screen.getAllByRole("option", { name: /Welcome/ })).toHaveLength(1);
  expect(screen.getByRole("alert")).toBeTruthy();
  fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
});
it("requires authority for every visible search domain without requiring invoke authority", () => {
  expect(uiProviders([plugin], "quickAccess")).toHaveLength(1);
  for (const omitted of permissions)
    expect(
      uiProviders(
        [{ ...plugin, permissions: permissions.filter((p) => p !== omitted) }],
        "quickAccess",
      ),
    ).toHaveLength(0);
});
