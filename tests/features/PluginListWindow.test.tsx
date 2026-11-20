import "@/i18n/i18n";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { WindowPluginsSection, PluginsSection } from "@/features/plugins/PluginsSection";
import { PluginPanelDialogs } from "@/features/plugins/panel/PluginPanelDialogs";
import { createPluginListSource, pluginListSource } from "@/features/plugins/panel/source";
import { executePluginListCommand } from "@/features/plugins/panel/actions";
import { pluginListKey } from "@/features/plugins/panel/model";
import { createPanelViewState, PanelViewStateScope } from "@/lib/panels/viewState";
import { PanelInteractionScope } from "@/lib/panels/interaction";
import type { PanelWindowClient } from "@/lib/panels/windowClient";
import { useMarketplace } from "@/store/marketplace";
import { usePlugins } from "@/store/plugins";
import { useWorkspace } from "@/store/workspace";
import { useDialogs } from "@/store/dialogs";
import type { MarketEntry, MarketSource, PluginInfo } from "@/lib/api/types";
const source: MarketSource = {
  id: "qa",
  name: "QA registry",
  url: "https://example.invalid/index.json",
  enabled: true,
};
const entry: MarketEntry = {
  id: "qa-tool",
  name: "QA Tool",
  version: "1.0.0",
  description: "Formatting",
  tags: ["tools"],
  url: "https://private.invalid/archive.zip",
  sha256: "a".repeat(64),
  apiVersion: 1,
  runtime: "frontend",
};
const originalMarket = useMarketplace.getState(),
  originalPlugins = usePlugins.getState(),
  originalWorkspace = useWorkspace.getState(),
  originalDialogs = useDialogs.getState();
beforeEach(() => {
  useMarketplace.setState({
    ...originalMarket,
    config: { sources: [source], nodePath: "private-node-path", nodeSystemAllowed: true },
    catalogues: { qa: { source, entries: [entry], checkedAt: 1, stale: false, error: null } },
    ready: true,
    configLoading: false,
    loading: [],
    tasks: {},
    query: "",
    tag: "",
    page: 0,
    scope: "market",
    errors: {},
    configError: null,
    load: vi.fn(async () => {}),
    install: vi.fn(async () => {}),
  });
  usePlugins.setState({ ...originalPlugins, items: [], busyIds: [], load: vi.fn(async () => {}) });
  useWorkspace.setState({ ...originalWorkspace, tabs: [], activeId: null });
  useDialogs.setState({ ...originalDialogs, dialog: { kind: "none" } });
});
afterEach(() => {
  useMarketplace.setState(originalMarket);
  usePlugins.setState(originalPlugins);
  useWorkspace.setState(originalWorkspace);
  useDialogs.setState(originalDialogs);
});
it("publishes display metadata only and rotates action markers for private catalogue changes and removal", () => {
  const s = createPluginListSource();
  usePlugins.setState({
    items: [
      {
        id: "installed",
        name: "Installed",
        version: "1.0.0",
        description: null,
        path: "/display/plugin",
        apiVersion: 1,
        status: "running",
        error: null,
        commands: [],
        views: [],
        permissions: ["private-grant"],
        runtimeId: "private-runtime",
        fingerprint: "private-fingerprint",
        frontend: { entry: "private-entry", sdk: "v1" },
      } as PluginInfo,
    ],
  });
  const first = s.snapshot(),
    text = JSON.stringify(first);
  for (const hidden of [
    "private-node-path",
    "private.invalid/archive",
    "private-grant",
    "private-runtime",
    "private-fingerprint",
    "private-entry",
    entry.sha256,
  ])
    expect(text).not.toContain(hidden);
  expect(JSON.parse(text)).toEqual(first);
  const key = pluginListKey("qa", entry.id),
    target = first.targets[key]!;
  useMarketplace.setState({
    catalogues: {
      qa: {
        source,
        entries: [{ ...entry, sha256: "b".repeat(64) }],
        checkedAt: 2,
        stale: false,
        error: null,
      },
    },
  });
  expect(() => s.resolve(target)).toThrow("pluginSecurity.changed");
  const edited = s.snapshot().targets[key]!;
  expect(edited.revision).not.toBe(target.revision);
  useMarketplace.setState({ config: { sources: [], nodePath: null, nodeSystemAllowed: false } });
  expect(() => s.resolve(edited)).toThrow("pluginSecurity.changed");
});
it("revalidates after main reveal and again at install confirmation without trusting caller payloads", async () => {
  const target = pluginListSource.snapshot().targets[pluginListKey("qa", entry.id)]!;
  await expect(
    executePluginListCommand({ operation: "open", target }, async () => {
      useMarketplace.setState({ catalogues: {} });
    }),
  ).rejects.toThrow("pluginSecurity.changed");
  useMarketplace.setState({
    catalogues: { qa: { source, entries: [entry], checkedAt: 1, stale: false, error: null } },
  });
  const current = pluginListSource.snapshot().targets[pluginListKey("qa", entry.id)]!;
  await executePluginListCommand({ operation: "install", target: current });
  const dialog = useDialogs.getState().dialog;
  expect(dialog.kind).toBe("confirm");
  useMarketplace.setState({
    catalogues: {
      qa: {
        source,
        entries: [{ ...entry, url: "https://changed.invalid/new.zip" }],
        checkedAt: 2,
        stale: false,
        error: null,
      },
    },
  });
  if (dialog.kind === "confirm") expect(() => dialog.onConfirm()).toThrow("pluginSecurity.changed");
  expect(useMarketplace.getState().install).not.toHaveBeenCalled();
});
it("renders projected remote data, preserves search/filter state, and relays only qualified actions", async () => {
  const data = pluginListSource.snapshot();
  useMarketplace.setState({ catalogues: {} });
  const state = createPanelViewState(),
    action = vi.fn(async () => true),
    client = { action } as unknown as PanelWindowClient,
    lease = { panelId: "plugins", windowId: "satellite", generation: 4 };
  const frame = (controller: typeof state) => (
    <PanelInteractionScope value={{ client, lease, staged: false }}>
      <PanelViewStateScope controller={controller}>
        <WindowPluginsSection data={data} />
      </PanelViewStateScope>
    </PanelInteractionScope>
  );
  const view = render(frame(state));
  expect(screen.getByText("QA Tool", { selector: "strong" })).toBeTruthy();
  expect(useMarketplace.getState().load).not.toHaveBeenCalled();
  expect(usePlugins.getState().load).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole("textbox", { name: "Search plugins" }), {
    target: { value: "@tag:tools QA" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Install" }));
  await waitFor(() =>
    expect(action).toHaveBeenCalledWith(lease, {
      kind: "plugins",
      command: { operation: "install", target: data.targets[pluginListKey("qa", entry.id)] },
    }),
  );
  expect(useDialogs.getState().dialog.kind).toBe("none");
  const captured = await state.captureAsync();
  expect(captured.fields["plugins.browser"]).toMatchObject({
    query: "@tag:tools QA",
    scope: "market",
    page: 0,
  });
  view.unmount();
  render(frame(createPanelViewState(JSON.parse(JSON.stringify(captured)))));
  expect((screen.getByRole("textbox", { name: "Search plugins" }) as HTMLInputElement).value).toBe(
    "@tag:tools QA",
  );
});
it("restores browser state in main while retaining existing store-driven detail-page navigation", async () => {
  const controller = createPanelViewState({
    version: 1,
    fields: { "plugins.browser": { query: "QA", tag: "", scope: "market", page: 0 } },
  });
  render(
    <PanelViewStateScope controller={controller}>
      <PluginsSection sidebar />
    </PanelViewStateScope>,
  );
  expect(useMarketplace.getState().query).toBe("QA");
  act(() => useMarketplace.getState().setQuery("@tag:tools"));
  expect((screen.getByRole("textbox", { name: "Search plugins" }) as HTMLInputElement).value).toBe(
    "@tag:tools",
  );
  expect((await controller.captureAsync()).fields["plugins.browser"]).toMatchObject({
    query: "@tag:tools",
  });
});

it("keeps main-owned local-install dialogs alive when the browser is removed", async () => {
  const frame = (browser: boolean) => (
    <>
      <PluginPanelDialogs />
      {browser ? <PluginsSection sidebar /> : null}
    </>
  );
  const view = render(frame(true));
  fireEvent.click(screen.getByRole("button", { name: "Install plugin" }));
  expect(screen.getByRole("dialog")).toBeTruthy();
  view.rerender(frame(false));
  expect(screen.getByRole("dialog")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("dialog")).toBeNull();
});
