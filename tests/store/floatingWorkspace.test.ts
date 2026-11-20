import { beforeEach, expect, it } from "vitest";
import {
  useWorkspace,
  visibleWorkspaceLayout,
  workspaceRecords,
  type WorkspaceTab,
} from "@/store/workspace";
import { usePlugins } from "@/store/plugins";
import type { PluginInfo, TabKind } from "@/lib/api/types";
import { panelPresentation } from "@/store/panelPresentation";
import { setPanelLocation } from "@/lib/panels/controller";
import { panelsSnapshot } from "@/lib/panels/observation";

beforeEach(() => {
  usePlugins.setState({ items: [] });
  useWorkspace.setState({
    tabs: [],
    panes: [{ id: "main", tabIds: [], activeId: null }],
    activePaneId: "main",
    activeId: null,
    layout: { kind: "pane", paneId: "main" },
    split: null,
  });
});
function seed(kind: TabKind, id = "page") {
  const tab: WorkspaceTab = { id, kind, title: "Page", hostId: null, pinned: false, preview: true };
  useWorkspace.setState({
    tabs: [tab],
    panes: [{ id: "main", tabIds: [id], activeId: id }],
    activeId: id,
  });
  return tab;
}
it.each<TabKind>([
  "welcome",
  "host",
  "settings",
  "about",
  "updates",
  "terminal",
  "sftp",
  "editor",
  "history",
  "monitor",
  "knownHosts",
  "pluginDetail",
])("floats and returns %s without recreating its identity", (kind) => {
  seed(kind);
  useWorkspace.getState().floatTab("page");
  const w = useWorkspace.getState();
  const floating = w.panes.find((p) => p.floating)!;
  expect(floating.tabIds).toEqual(["page"]);
  expect(w.tabs).toHaveLength(1);
  expect(w.tabs[0]).toMatchObject({ id: "page", kind, preview: false });
  expect(visibleWorkspaceLayout(w.layout, w.panes, w.tabs)).toEqual({
    kind: "pane",
    paneId: "main",
  });
  w.dockPane(floating.id);
  expect(useWorkspace.getState().panes).toEqual([
    { id: "main", tabIds: ["page"], activeId: "page" },
  ]);
});
it("moves only the selected page and supports drag redocking through the existing move adapter", () => {
  seed("host", "one");
  useWorkspace.setState((s) => ({
    tabs: [...s.tabs, { ...s.tabs[0]!, id: "two" }],
    panes: [{ id: "main", tabIds: ["one", "two"], activeId: "two" }],
  }));
  const w = useWorkspace.getState();
  w.floatTab("two");
  expect(useWorkspace.getState().panes.find((p) => p.id === "main")?.tabIds).toEqual(["one"]);
  w.moveTab("two", "main", "one");
  expect(useWorkspace.getState().panes).toEqual([
    { id: "main", tabIds: ["two", "one"], activeId: "two" },
  ]);
});
it("keeps runtime geometry out of frozen v1 and restores cold-start pages docked", () => {
  seed("settings", "page:settings");
  useWorkspace.getState().floatTab("page:settings");
  const floating = useWorkspace.getState().panes.find((p) => p.floating)!;
  useWorkspace.getState().setFloatingBounds(floating.id, { x: 8, y: 9, width: 500, height: 400 });
  const records = workspaceRecords();
  expect(records[0]!.state).not.toContain("floating");
  expect(records[0]!.state).not.toContain("returnPaneId");
  useWorkspace.getState().hydrate(records);
  expect(useWorkspace.getState().tabs[0]!.id).toBe("page:settings");
  expect(useWorkspace.getState().panes.some((p) => p.floating)).toBe(false);
});
it("rejects invalid geometry and shares stacking with sidebar panels", () => {
  seed("settings");
  const w = useWorkspace.getState();
  w.floatTab("page");
  const floating = useWorkspace.getState().panes.find((p) => p.floating)!;
  w.setFloatingBounds(floating.id, { x: NaN, y: 0, width: 1, height: 1 });
  expect(
    useWorkspace.getState().panes.find((p) => p.id === floating.id)?.floating?.bounds,
  ).toBeNull();
  panelPresentation("tasks").getState().show();
  expect(panelPresentation("tasks").getState().order).toBeGreaterThan(floating.floating!.order);
  w.activatePane(floating.id);
  expect(useWorkspace.getState().panes.find((p) => p.floating)?.floating?.order).toBeGreaterThan(
    panelPresentation("tasks").getState().order,
  );
  panelPresentation("tasks").getState().close();
});
it("enforces a plugin opt-out in both the tab and sidebar mutation paths", () => {
  seed("pluginView", "plugin:sample:main");
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
      } as PluginInfo,
    ],
  });
  useWorkspace.getState().floatTab("plugin:sample:main");
  expect(useWorkspace.getState().panes.some((p) => p.floating)).toBe(false);
  expect(() => setPanelLocation("plugin:sample:main", "floating")).toThrow(
    "panel.presentationUnsupported",
  );
  expect(panelsSnapshot().panels.find((p) => p.id === "plugin:sample:main")?.presentations).toEqual(
    ["sidebar", "workspace"],
  );
});
it("allows plugins by default and ignores missing IDs", () => {
  seed("pluginView", "plugin:sample:main");
  useWorkspace.getState().floatTab("missing");
  expect(useWorkspace.getState().panes).toHaveLength(1);
  useWorkspace.getState().floatTab("plugin:sample:main");
  expect(useWorkspace.getState().panes.some((p) => p.floating)).toBe(true);
});
it("cannot bypass plugin opt-out by dragging into a floating group or opening from it", () => {
  seed("settings", "page:settings");
  useWorkspace.getState().floatTab("page:settings");
  const floating = useWorkspace.getState().panes.find((p) => p.floating)!;
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
        views: [{ id: "main", title: "Main", allowFloating: false }],
      },
    ],
  });
  useWorkspace.getState().openPluginView("sample", "main", "Main");
  expect(useWorkspace.getState().panes.find((p) => p.id === "main")?.tabIds).toContain(
    "plugin:sample:main",
  );
  useWorkspace.getState().moveTab("plugin:sample:main", floating.id);
  expect(useWorkspace.getState().panes.find((p) => p.id === floating.id)?.tabIds).toEqual([
    "page:settings",
  ]);
});
