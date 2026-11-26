import type { PanelWindowClient } from "@/lib/panels/windowClient";
import { beforeEach, expect, it, vi } from "vitest";
import { useNavigation } from "@/store/navigation";
import { useWorkspace } from "@/store/workspace";
import { usePlugins } from "@/store/plugins";
import { panelPresentation } from "@/store/panelPresentation";
import { SIDEBAR_VIEWS } from "@/lib/session/sidebarDock";
import { closePanel, revealPanel, setPanelLocation } from "@/lib/panels/controller";
import { panelsSnapshot, observePanels, subscribePanels } from "@/lib/panels/observation";
import { requirePanel } from "@/lib/panels/snapshot";
import { useFilePreview } from "@/store/filePreview";

beforeEach(() => {
  usePlugins.setState({ items: [] });
  useFilePreview.setState({ file: null });
  for (const view of SIDEBAR_VIEWS)
    panelPresentation(view).setState({ open: false, preferred: null, pinned: false, bounds: null });
  useWorkspace.setState({
    tabs: [],
    panes: [{ id: "pane-1", tabIds: [], activeId: null }],
    activeId: null,
    activePaneId: "pane-1",
    split: null,
    layout: { kind: "pane", paneId: "pane-1" },
  });
  useNavigation.setState({
    sidebarVisible: true,
    activeSidebar: "hosts",
    visitedSidebars: ["hosts"],
  });
});
it("moves one identity through all presentations and close retains its last location", () => {
  setPanelLocation("hosts", "floating");
  expect(useNavigation.getState().sidebarVisible).toBe(false);
  expect(panelsSnapshot().panels.find((p) => p.id === "hosts")).toMatchObject({
    presentation: "floating",
    visible: true,
  });
  setPanelLocation("hosts", "workspace");
  expect(panelPresentation("hosts").getState().open).toBe(false);
  expect(useWorkspace.getState().tabs.filter((t) => t.id === "sidebar:hosts")).toHaveLength(1);
  closePanel("hosts");
  expect(panelsSnapshot().panels.find((p) => p.id === "hosts")).toMatchObject({
    presentation: "workspace",
    visible: false,
  });
  revealPanel("hosts");
  expect(useWorkspace.getState().tabs[0]?.hidden).toBe(false);
  setPanelLocation("hosts", "floating");
  expect(useWorkspace.getState().tabs.some((t) => t.id === "sidebar:hosts")).toBe(false);
  closePanel("hosts");
  expect(panelsSnapshot().panels.find((p) => p.id === "hosts")).toMatchObject({
    presentation: "floating",
    visible: false,
  });
  revealPanel("hosts");
  expect(panelPresentation("hosts").getState().open).toBe(true);
  setPanelLocation("hosts", "sidebar");
  expect(useNavigation.getState()).toMatchObject({ sidebarVisible: true, activeSidebar: "hosts" });
});
it("coalesces compound layout moves and excludes unrelated resource contents", async () => {
  const changed = vi.fn();
  const stop = subscribePanels(changed);
  setPanelLocation("tasks", "workspace");
  setPanelLocation("tasks", "floating");
  await Promise.resolve();
  expect(changed).toHaveBeenCalledTimes(1);
  const before = panelsSnapshot();
  usePlugins.setState({ outputs: { secret: { text: "private draft", error: false } } });
  await Promise.resolve();
  expect(changed).toHaveBeenCalledTimes(1);
  expect(panelsSnapshot()).toEqual(before);
  expect(JSON.stringify(before)).not.toContain("private draft");
  stop();
  closePanel("tasks");
  await Promise.resolve();
  expect(changed).toHaveBeenCalledTimes(1);
});
it("observes a new revision and releases cancellation/timeout subscriptions", async () => {
  const initial = panelsSnapshot();
  expect(await observePanels("old")).toEqual(initial);
  const pending = observePanels(initial.revision);
  setPanelLocation("connections", "floating");
  expect((await pending).revision).not.toBe(initial.revision);
  const controller = new AbortController();
  const aborted = observePanels(panelsSnapshot().revision, controller.signal);
  controller.abort();
  await expect(aborted).rejects.toThrow("requestCancelled");
  await expect(observePanels(undefined, controller.signal)).rejects.toThrow("requestCancelled");
  vi.useFakeTimers();
  try {
    const current = panelsSnapshot();
    const timeout = observePanels(current.revision);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await timeout).toEqual(current);
  } finally {
    vi.useRealTimers();
  }
});
it("rejects nonexistent contributions and unavailable previews", () => {
  expect(() => requirePanel("not-a-panel")).toThrow("invalid:panelId");
  expect(() => requirePanel("plugin:missing:view")).toThrow("panel.notFound");
  expect(() => requirePanel("filePreview")).toThrow("panel.unavailable");
});
it("focuses a detached owner from status/navigation without opening duplicate local content", async () => {
  const { createWindowViews, installWindowViews } = await import("@/lib/panels/windowViews");
  const { usePanelWindows } = await import("@/store/panelWindows");
  const { togglePanel, togglePanelAt } = await import("@/lib/panels/controller");
  const focus = vi.fn().mockResolvedValue(null);
  const { windowId, available, snapshot } = usePanelWindows.getState();
  const uninstall = installWindowViews(
    createWindowViews({
      windowId: "main",
      focus,
    } as unknown as PanelWindowClient),
  );
  try {
    usePanelWindows.setState({
      windowId: "main",
      available: true,
      snapshot: {
        windows: [],
        panels: [{ panelId: "connections", windowId: "panel-one", generation: 7 }],
        transfers: [],
      },
    });
    revealPanel("connections");
    togglePanel("connections");
    togglePanelAt("connections", "floating");
    expect(focus).toHaveBeenCalledTimes(3);
    expect(focus).toHaveBeenCalledWith("connections");
    expect(useNavigation.getState().activeSidebar).toBe("hosts");
    expect(panelPresentation("connections").getState().open).toBe(false);
    expect(useWorkspace.getState().tabs).toEqual([]);
  } finally {
    uninstall();
    usePanelWindows.setState({ windowId, available, snapshot });
  }
});

it("keeps the main source adapter from reading or mutating a remotely owned panel", async () => {
  const { createMainPanelPresentation } = await import("@/lib/panels/mainPresentation");
  const { usePanelWindows } = await import("@/store/panelWindows");
  const previous = usePanelWindows.getState();
  try {
    usePanelWindows.setState({
      windowId: "main",
      available: true,
      snapshot: {
        windows: [],
        transfers: [],
        panels: [
          { panelId: "tasks", windowId: "main", generation: 3 },
          { panelId: "connections", windowId: "satellite", generation: 4 },
        ],
      },
    });
    const host = createMainPanelPresentation();
    expect(host.read().map((p) => p.id)).toEqual(["tasks"]);
    const navigation = useNavigation.getState(),
      workspace = useWorkspace.getState();
    expect(() => host.set("connections", "floating")).toThrow("staleOwner");
    expect(() => host.close("connections")).toThrow("staleOwner");
    expect(() => host.reveal("connections")).toThrow("staleOwner");
    expect(useNavigation.getState()).toBe(navigation);
    expect(useWorkspace.getState()).toBe(workspace);
    expect(host.set("tasks", "floating")).toMatchObject({
      id: "tasks",
      visible: true,
      presentation: "floating",
    });
    host.close("tasks");
    expect(host.read()[0]?.visible).toBe(false);
    host.reveal("tasks");
    expect(host.read()[0]?.visible).toBe(true);
    expect(() => host.set("tasks", "invalid" as never)).toThrow("unsupportedPresentation");
  } finally {
    usePanelWindows.setState(previous);
  }
});

it("opens an opted-out contribution in the sidebar despite an old floating preference", () => {
  usePlugins.setState({
    items: [
      {
        id: "sample",
        name: "Sample",
        version: "1.0.0",
        apiVersion: 1,
        description: null,
        commands: [],
        permissions: [],
        status: "stopped",
        error: null,
        path: "/qa",
        runtime: "node",
        views: [{ id: "main", title: "Main", location: "sidebar", allowFloating: false }],
      },
    ],
  });
  panelPresentation("plugin:sample:main").setState({ preferred: "floating", open: false });
  expect(() => revealPanel("plugin:sample:main", "floating")).not.toThrow();
  expect(useNavigation.getState()).toMatchObject({
    activeSidebar: "plugin:sample:main",
    sidebarVisible: true,
  });
  expect(panelsSnapshot().panels.find((p) => p.id === "plugin:sample:main")).toMatchObject({
    presentation: "sidebar",
    visible: true,
    presentations: ["sidebar", "workspace"],
  });
});

it("opens tasks at the explicitly requested entry location regardless of saved preference", async () => {
  const { togglePanelAt } = await import("@/lib/panels/controller");
  setPanelLocation("tasks", "workspace");
  panelPresentation("tasks").getState().setBounds({ x: 0, y: 0, width: 540, height: 560 });
  togglePanelAt("tasks", "floating");
  expect(useWorkspace.getState().tabs.some((tab) => tab.id === "sidebar:tasks")).toBe(false);
  expect(panelPresentation("tasks").getState()).toMatchObject({ open: true, bounds: null });
  togglePanelAt("tasks", "sidebar");
  expect(panelPresentation("tasks").getState().open).toBe(false);
  expect(useNavigation.getState()).toMatchObject({ activeSidebar: "tasks", sidebarVisible: true });
  togglePanelAt("tasks", "sidebar");
  expect(useNavigation.getState().sidebarVisible).toBe(false);
  togglePanelAt("tasks", "floating");
  expect(panelPresentation("tasks").getState().open).toBe(true);
  togglePanelAt("tasks", "floating");
  expect(panelPresentation("tasks").getState().open).toBe(false);
});
