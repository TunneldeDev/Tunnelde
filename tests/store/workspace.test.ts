import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Host, SshSession, TabRecord } from "@/lib/api/types";
import { useWorkspace, workspaceRecords, visibleWorkspaceLayout } from "@/store/workspace";
import { useEditors } from "@/store/editors";
import { useDialogs } from "@/store/dialogs";
import { useNavigation } from "@/store/navigation";

const state = () => useWorkspace.getState();

const host = (id: string, name: string): Host => ({
  id,
  groupId: null,
  name,
  host: `${id}.example.com`,
  port: 22,
  username: "root",
  authMethod: "password",
  keyPath: null,
  favorite: false,
  color: null,
  tags: [],
  note: null,
  sortOrder: 0,
  lastUsedAt: null,
  createdAt: 0,
  updatedAt: 0,
});

const session = (id: string, title: string): SshSession => ({
  id,
  hostId: "a",
  title,
  address: "root@example.com:22",
  cols: 120,
  rows: 32,
  connectedAt: 0,
});
const record = (id: string, kind: TabRecord["kind"], hostId: string | null = null): TabRecord => ({
  id,
  kind,
  title: id,
  hostId,
  sortOrder: 0,
  pinned: false,
  state: null,
});

it("migrates old updates tabs into a single settings tab while preserving pane placement", () => {
  const metadata = JSON.stringify({
    version: 1,
    layout: { kind: "pane", paneId: "right" },
    panes: [{ id: "right", tabIds: ["page:updates", "page:settings"], activeId: "page:updates" }],
    activePaneId: "right",
  });
  state().hydrate([
    { ...record("page:updates", "updates"), state: metadata },
    record("page:settings", "settings"),
  ]);
  expect(state().tabs.map((tab) => tab.id)).toEqual(["page:settings"]);
  expect(state().panes[0]!.tabIds).toEqual(["page:settings"]);
  expect(state().panes[0]!.activeId).toBe("page:settings");
  expect(state().activePaneId).toBe("right");
  state().openPage("updates", { preview: false });
  expect(state().tabs).toHaveLength(1);
  expect(useNavigation.getState().settingsSection).toBe("updates");
});

beforeEach(() => {
  useNavigation.setState({
    activeSidebar: "hosts",
    sidebarVisible: true,
    visitedSidebars: ["hosts"],
  });
  useWorkspace.setState({
    tabs: [],
    panes: [{ id: "pane-1", tabIds: [], activeId: null }],
    activePaneId: "pane-1",
    activeId: null,
    split: null,
    layout: { kind: "pane", paneId: "pane-1" },
  });
});

describe("preview navigation tabs", () => {
  it("keeps a dirty preview and promotes it before opening another preview", () => {
    const tabId = "editor:session-one:/file.txt";
    useWorkspace.setState({
      tabs: [
        {
          id: tabId,
          kind: "editor",
          title: "file.txt",
          hostId: null,
          pinned: false,
          preview: true,
        },
      ],
      panes: [{ id: "pane-1", tabIds: [tabId], activeId: tabId }],
      activeId: tabId,
    });
    useEditors.setState({
      entries: {
        [tabId]: {
          tabId,
          sessionId: "session-one",
          path: "/file.txt",
          name: "file.txt",
          content: "changed",
          baseline: "original",
          loading: false,
          saving: false,
          error: null,
        },
      },
    });
    state().openPage("about");
    expect(state().tabs.find((tab) => tab.id === tabId)?.preview).toBe(false);
    expect(
      state()
        .tabs.filter((tab) => tab.preview)
        .map((tab) => tab.id),
    ).toEqual(["page:about"]);
    expect(useEditors.getState().isDirty(tabId)).toBe(true);
  });

  it("reuses one preview slot in place across plugins, host details and pages", () => {
    state().openPage("welcome");
    state().openPluginDetail("official", "uuid", "UUID");
    state().openPage("settings");
    state().openHost(host("a", "Alpha"));
    expect(state().panes[0]?.tabIds).toEqual(["page:welcome", "host:a"]);
    expect(state().tabs.find((tab) => tab.id === "host:a")?.preview).toBe(true);
    expect(state().activeId).toBe("host:a");
  });

  it("keeps a preview on the second selection and creates a new preview for the next item", () => {
    state().openPluginDetail("official", "uuid", "UUID");
    state().openPluginDetail("official", "uuid", "UUID");
    expect(state().tabs[0]).toMatchObject({ preview: false, pinned: false });
    state().openPluginDetail("official", "other", "Other");
    state().openPage("about");
    expect(state().tabs.map((tab) => tab.id)).toEqual(["extension:official:uuid", "page:about"]);
  });

  it("uses an independent preview slot in each pane and respects the locked destination", () => {
    state().openPage("welcome");
    state().openPage("settings");
    state().splitTab("page:settings", "row");
    const second = state().activePaneId;
    state().openPage("about");
    state().activatePane("pane-1");
    state().openHost(host("a", "Alpha"));
    expect(state().tabs.filter((tab) => tab.preview)).toHaveLength(2);
    state().togglePaneLock(second);
    state().openPluginDetail("official", "uuid", "UUID");
    expect(state().tabs.some((tab) => tab.id === "page:about")).toBe(false);
    expect(state().tabs.some((tab) => tab.id === "host:a")).toBe(true);
    expect(state().panes.find((pane) => pane.id === second)?.tabIds).toContain(
      "extension:official:uuid",
    );
  });

  it("keeps an existing fixed page fixed and activates its owning pane", () => {
    state().openPage("welcome");
    state().openPage("settings", { preview: false });
    state().splitTab("page:settings", "row");
    const owner = state().activePaneId;
    state().activatePane("pane-1");
    state().openPage("settings");
    expect(state().activePaneId).toBe(owner);
    expect(state().tabs.find((tab) => tab.id === "page:settings")?.preview).not.toBe(true);
  });

  it("never replaces terminals or explicitly opened file editors", () => {
    state().openTerminal(session("s1", "Terminal"));
    state().openSftp(session("s1", "Files"));
    state().openPage("settings");
    state().openPage("about");
    expect(state().tabs.map((tab) => tab.id)).toEqual(["terminal:s1", "sftp:s1", "page:about"]);
  });

  it("promotes previews when pinned, moved or merged so groups retain at most one preview", () => {
    state().openPage("welcome");
    state().openPage("settings");
    state().togglePin("page:settings");
    expect(state().tabs.find((tab) => tab.id === "page:settings")).toMatchObject({
      preview: false,
      pinned: true,
    });
    state().openPage("about");
    state().splitTab("page:about", "row");
    state().openHost(host("a", "Alpha"));
    const second = state().activePaneId;
    state().activatePane("pane-1");
    state().openPluginView("uuid", "main", "UUID");
    state().closePane(second);
    expect(state().tabs.filter((tab) => tab.preview)).toHaveLength(1);
    expect(state().tabs.find((tab) => tab.id === "host:a")?.preview).toBe(false);
  });

  it("persists the replaceable state and restores it without changing pinned semantics", () => {
    state().openPage("welcome");
    state().openPage("settings");
    state().hydrate(workspaceRecords());
    expect(state().tabs.find((tab) => tab.id === "page:settings")).toMatchObject({
      preview: true,
      pinned: false,
    });
    state().openPage("about");
    expect(state().tabs.map((tab) => tab.id)).toEqual(["page:welcome", "page:about"]);
  });
});

describe("workspace tabs", () => {
  it("collapses docked sidebars without changing their saved groups, position or ratios", () => {
    state().openPage("welcome", { preview: false });
    state().splitTab("sidebar:plugins", "row", "after", "pane-1");
    const pluginPane = state().panes.find((pane) => pane.tabIds.includes("sidebar:plugins"))!;
    const initialLayout = state().layout;
    if (initialLayout.kind === "split") state().resizeSplit(initialLayout.id, 0.72);
    const layout = state().layout;
    const tabIds = pluginPane.tabIds;
    state().toggleDockedSidebar("plugins");
    expect(state().tabs.find((tab) => tab.id === "sidebar:plugins")?.hidden).toBe(true);
    expect(state().panes.find((pane) => pane.id === pluginPane.id)?.tabIds).toEqual(tabIds);
    expect(state().layout).toEqual(layout);
    expect(visibleWorkspaceLayout(state().layout, state().panes, state().tabs)).toEqual({
      kind: "pane",
      paneId: "pane-1",
    });
    expect(state().activeId).toBe("page:welcome");
    state().toggleDockedSidebar("plugins");
    expect(state().tabs.find((tab) => tab.id === "sidebar:plugins")?.hidden).toBe(false);
    expect(state().activePaneId).toBe(pluginPane.id);
    expect(state().activeId).toBe("sidebar:plugins");
    expect(visibleWorkspaceLayout(state().layout, state().panes, state().tabs)).toEqual(layout);
  });

  it("programmatic opens reveal only the requested sidebar and persist other collapsed slots", () => {
    state().openPage("welcome", { preview: false });
    state().splitTab("sidebar:plugins", "row", "after", "pane-1");
    state().splitTab("sidebar:knownHosts", "column", "after", "pane-1");
    state().toggleDockedSidebar("plugins");
    state().toggleDockedSidebar("knownHosts");
    state().openPage("about", { preview: false });
    expect(
      state()
        .tabs.filter((tab) => tab.hidden)
        .map((tab) => tab.id)
        .sort(),
    ).toEqual(["sidebar:knownHosts", "sidebar:plugins"]);
    const layout = state().layout;
    state().hydrate(workspaceRecords());
    expect(state().layout).toEqual(layout);
    expect(state().tabs.filter((tab) => tab.hidden)).toHaveLength(2);
    useNavigation.getState().showSidebar("plugins");
    state().openSidebar("plugins");
    expect(state().activeId).toBe("sidebar:plugins");
    expect(state().tabs.find((tab) => tab.id === "sidebar:plugins")?.hidden).toBe(false);
    expect(state().tabs.find((tab) => tab.id === "sidebar:knownHosts")?.hidden).toBe(true);
  });

  it("activates a docked background tab before collapsing it and preserves hidden tabs on Close others", () => {
    state().openSidebar("plugins");
    state().openPage("welcome", { preview: false });
    state().toggleDockedSidebar("plugins");
    expect(state().activeId).toBe("sidebar:plugins");
    expect(state().tabs.find((tab) => tab.id === "sidebar:plugins")?.hidden).not.toBe(true);
    state().toggleDockedSidebar("plugins");
    state().openPage("about", { preview: false });
    state().closeOthers("page:about");
    expect(state().tabs.map((tab) => tab.id)).toEqual(["sidebar:plugins", "page:about"]);
    expect(state().tabs[0]?.hidden).toBe(true);
    state().activate("sidebar:plugins");
    expect(state().tabs[0]?.hidden).toBe(false);
  });

  it("keeps exactly one default group and sends ordinary new pages there without moving existing tabs", () => {
    state().openPage("welcome", { preview: false });
    state().openPage("settings", { preview: false });
    state().splitTab("page:settings", "row");
    const second = state().activePaneId;
    state().togglePaneLock("pane-1");
    state().openPage("about", { preview: false });
    expect(state().activePaneId).toBe("pane-1");
    state().openPage("settings", { preview: false });
    expect(state().activePaneId).toBe(second);
    expect(state().panes.find((pane) => pane.id === second)?.tabIds).toEqual(["page:settings"]);
    state().togglePaneLock(second);
    expect(
      state()
        .panes.filter((pane) => pane.locked)
        .map((pane) => pane.id),
    ).toEqual([second]);
    state().togglePaneLock(second);
    expect(state().panes.some((pane) => pane.locked)).toBe(false);
  });

  it("keeps an empty locked default group through close, persistence and welcome recovery", () => {
    state().openPage("welcome", { preview: false });
    state().openPage("settings", { preview: false });
    state().splitTab("page:settings", "row");
    state().togglePaneLock("pane-1");
    state().close("page:welcome");
    expect(state().panes.find((pane) => pane.id === "pane-1")).toMatchObject({
      locked: true,
      tabIds: [],
      activeId: null,
    });
    const layout = state().layout;
    state().hydrate(workspaceRecords());
    expect(state().layout).toEqual(layout);
    expect(state().panes.find((pane) => pane.id === "pane-1")?.locked).toBe(true);
    state().close("page:settings");
    state().ensureWelcome();
    expect(state().activePaneId).toBe("pane-1");
    expect(state().panes[0]?.tabIds).toEqual(["page:welcome"]);
    expect(state().panes[0]?.locked).toBe(true);
  });

  it("restores an entirely empty locked group without exposing its metadata as a tab", () => {
    state().openPage("welcome", { preview: false });
    state().openPage("settings", { preview: false });
    state().splitTab("page:settings", "row");
    const lockedPane = state().activePaneId;
    state().togglePaneLock(lockedPane);
    state().close("page:welcome");
    state().close("page:settings");
    const panes = state().panes;
    const layout = state().layout;
    const records = workspaceRecords();
    expect(state().tabs).toEqual([]);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      id: "workspace:layout",
      kind: "welcome",
      title: "Tunnelde",
    });
    expect(records[0]?.state).toBeTruthy();
    state().hydrate([]);
    state().hydrate(records);
    expect(state().tabs).toEqual([]);
    expect(state().panes).toEqual(panes);
    expect(state().layout).toEqual(layout);
    expect(workspaceRecords()).toEqual(records);
    state().ensureWelcome();
    expect(state().activePaneId).toBe(lockedPane);
    expect(state().panes).toEqual([
      { id: lockedPane, locked: true, tabIds: ["page:welcome"], activeId: "page:welcome" },
    ]);
    expect(state().tabs.map((tab) => tab.id)).toEqual(["page:welcome"]);
    expect(workspaceRecords().map((record) => record.id)).toEqual(["page:welcome"]);
  });

  it("keeps an unlocked empty workspace free of metadata records", () => {
    expect(workspaceRecords()).toEqual([]);
    state().openPage("welcome", { preview: false });
    state().togglePaneLock("pane-1");
    state().close("page:welcome");
    state().togglePaneLock("pane-1");
    expect(workspaceRecords()).toEqual([]);
  });

  it("never displays a reserved layout record when its metadata is invalid", () => {
    state().hydrate([{ ...record("workspace:layout", "welcome"), state: "invalid" }]);
    expect(state().tabs).toEqual([]);
    state().ensureWelcome();
    expect(state().tabs.map((tab) => tab.id)).toEqual(["page:welcome"]);
  });

  it("closing a locked group keeps its tabs while removing the closed default destination", () => {
    state().openPage("welcome", { preview: false });
    state().openPage("settings", { preview: false });
    state().splitTab("page:settings", "row");
    state().togglePaneLock("pane-1");
    state().closePane("pane-1");
    expect(state().panes).toHaveLength(1);
    expect(state().tabs).toHaveLength(2);
    expect(state().panes.some((pane) => pane.locked)).toBe(false);
    state().openPage("about", { preview: false });
    expect(state().panes[0]?.tabIds).toContain("page:about");
  });

  it("opens ordinary content in a collapsed default group while keeping its sidebar collapsed", () => {
    state().openPage("welcome", { preview: false });
    state().splitTab("sidebar:plugins", "row", "after", "pane-1");
    const defaultPane = state().activePaneId;
    state().togglePaneLock(defaultPane);
    const layout = state().layout;
    state().toggleDockedSidebar("plugins");
    state().openPage("settings", { preview: false });
    expect(state().activePaneId).toBe(defaultPane);
    expect(state().activeId).toBe("page:settings");
    expect(state().tabs.find((tab) => tab.id === "sidebar:plugins")?.hidden).toBe(true);
    expect(state().panes.find((pane) => pane.id === defaultPane)?.tabIds).toEqual([
      "sidebar:plugins",
      "page:settings",
    ]);
    expect(visibleWorkspaceLayout(state().layout, state().panes, state().tabs)).toEqual(layout);
    state().closeOthers("page:settings");
    expect(state().tabs.find((tab) => tab.id === "sidebar:plugins")?.hidden).toBe(true);
    state().openSidebar("plugins");
    expect(state().activePaneId).toBe(defaultPane);
    expect(state().activeId).toBe("sidebar:plugins");
    state().toggleDockedSidebar("plugins");
    expect(state().activeId).toBe("page:settings");
  });

  it.each(["before", "after"] as const)(
    "preserves sidebar width when docking %s a workspace that expands after its sidebar closes",
    (position) => {
      state().openPage("welcome", { preview: false });
      const workspace = document.createElement("div");
      workspace.className = "workspace";
      const sidebar = document.createElement("div");
      sidebar.className = "sidebar-view";
      const panel = document.createElement("div");
      panel.dataset.sidebarPanel = "hosts";
      sidebar.append(panel);
      document.body.append(workspace, sidebar);
      vi.spyOn(workspace, "getBoundingClientRect").mockReturnValue({
        width: 740,
        height: 700,
      } as DOMRect);
      vi.spyOn(sidebar, "getBoundingClientRect").mockReturnValue({
        width: 260,
        height: 700,
      } as DOMRect);
      try {
        state().splitTab("sidebar:hosts", "row", position, "root");
        const layout = state().layout;
        expect(layout.kind).toBe("split");
        if (layout.kind === "split")
          expect((position === "before" ? layout.ratio : 1 - layout.ratio) * 996).toBeCloseTo(260);
      } finally {
        workspace.remove();
        sidebar.remove();
      }
    },
  );

  it.each(["row", "column"] as const)(
    "preserves a docked panel's %s size when moving it beside the surviving group",
    (direction) => {
      state().openPage("welcome", { preview: false });
      state().splitTab("sidebar:plugins", direction, "after", "pane-1");
      const workspace = document.createElement("div");
      workspace.className = "workspace";
      const source = document.createElement("section");
      source.className = "pane";
      const panel = document.createElement("div");
      panel.dataset.sidebarPanel = "plugins";
      source.append(panel);
      workspace.append(source);
      document.body.append(workspace);
      vi.spyOn(workspace, "getBoundingClientRect").mockReturnValue({
        width: 1000,
        height: 700,
      } as DOMRect);
      vi.spyOn(source, "getBoundingClientRect").mockReturnValue({
        width: 260,
        height: 210,
      } as DOMRect);
      try {
        state().splitTab("sidebar:plugins", direction, "after", "pane-1");
        const layout = state().layout;
        expect(layout.kind).toBe("split");
        if (layout.kind === "split")
          expect((1 - layout.ratio) * (direction === "row" ? 996 : 696)).toBeCloseTo(
            direction === "row" ? 260 : 210,
          );
      } finally {
        workspace.remove();
      }
    },
  );

  it("materializes a sidebar only after a valid drop, and opens each view once", () => {
    state().openPage("welcome", { preview: false });
    state().moveTab("sidebar:plugins", "missing-pane");
    expect(state().tabs.map((tab) => tab.id)).toEqual(["page:welcome"]);
    state().moveTab("sidebar:plugins", "pane-1", "page:welcome");
    state().openSidebar("plugins");
    expect(state().panes[0]?.tabIds).toEqual(["sidebar:plugins", "page:welcome"]);
    expect(state().tabs.filter((tab) => tab.kind === "sidebar")).toHaveLength(1);
    expect(state().activeId).toBe("sidebar:plugins");
    expect(useNavigation.getState().visitedSidebars).toContain("plugins");
  });

  it("saves and restores sidebar panels in nested splits without accepting arbitrary sidebar ids", () => {
    state().openPage("welcome", { preview: false });
    state().splitTab("sidebar:hosts", "row", "before", "pane-1");
    state().splitTab("sidebar:plugins", "column", "after", "pane-1");
    const layout = state().layout;
    const panes = state().panes;
    const records = workspaceRecords();
    records.push(record("sidebar:unknown", "sidebar"));
    state().hydrate(records);
    expect(state().layout).toEqual(layout);
    expect(state().panes).toEqual(panes);
    expect(
      state()
        .tabs.filter((tab) => tab.kind === "sidebar")
        .map((tab) => tab.id)
        .sort(),
    ).toEqual(["sidebar:hosts", "sidebar:plugins"]);
  });

  it("focuses docked lists through activity navigation without changing the visible side view", () => {
    state().openSidebar("plugins");
    state().openPage("welcome", { preview: false });
    useNavigation.getState().showSidebar("knownHosts");
    useNavigation.getState().selectSidebar("plugins");
    expect(state().activeId).toBe("sidebar:plugins");
    expect(useNavigation.getState().activeSidebar).toBe("knownHosts");
    expect(useNavigation.getState().sidebarVisible).toBe(true);
    expect(state().tabs.filter((tab) => tab.kind === "sidebar")).toHaveLength(1);
  });

  it("returns a closed sidebar tab to its original side view and prunes the empty group", () => {
    state().openPage("welcome", { preview: false });
    state().splitTab("sidebar:knownHosts", "column", "after", "pane-1");
    state().close("sidebar:knownHosts");
    expect(state().panes).toHaveLength(1);
    expect(state().tabs.map((tab) => tab.id)).toEqual(["page:welcome"]);
    expect(useNavigation.getState()).toMatchObject({
      activeSidebar: "knownHosts",
      sidebarVisible: true,
    });
  });

  it("can expose an undocked sidebar with the global sidebar toggle after docking the active one", () => {
    state().openSidebar("hosts");
    useNavigation.getState().toggleSidebar();
    expect(useNavigation.getState()).toMatchObject({
      activeSidebar: "knownHosts",
      sidebarVisible: true,
    });
  });

  it("opens a page once", () => {
    useWorkspace.getState().openPage("settings", { preview: false });
    useWorkspace.getState().openPage("settings", { preview: false });
    const { tabs, activeId } = useWorkspace.getState();
    expect(tabs).toHaveLength(1);
    expect(activeId).toBe("page:settings");
  });

  it("opens host tabs and renames them in place", () => {
    useWorkspace.getState().openHost(host("a", "Alpha"));
    useWorkspace.getState().openHost(host("a", "Alpha 2"));
    const { tabs } = useWorkspace.getState();
    expect(tabs).toHaveLength(1);
    expect(tabs[0]?.title).toBe("Alpha 2");
  });

  it("activates the neighbouring tab when closing", () => {
    useWorkspace.getState().openPage("welcome", { preview: false });
    useWorkspace.getState().openPage("settings", { preview: false });
    useWorkspace.getState().close("page:settings");
    expect(useWorkspace.getState().activeId).toBe("page:welcome");
  });

  it("reorders tabs inside the active pane", () => {
    useWorkspace.getState().openPage("welcome", { preview: false });
    useWorkspace.getState().openPage("settings", { preview: false });
    useWorkspace.getState().reorder(0, 1);
    const state = useWorkspace.getState();
    const kinds = (state.panes[0]?.tabIds ?? []).map(
      (id) => state.tabs.find((tab) => tab.id === id)?.kind,
    );
    expect(kinds).toEqual(["settings", "welcome"]);
  });

  it("splits a tab into a second pane", () => {
    useWorkspace.getState().openPage("welcome", { preview: false });
    useWorkspace.getState().openPage("settings", { preview: false });
    useWorkspace.getState().splitTab("page:settings", "row");

    const state = useWorkspace.getState();
    expect(state.panes).toHaveLength(2);
    expect(state.split).toBe("row");
    expect(state.panes[1]?.tabIds).toEqual(["page:settings"]);
    expect(state.activeId).toBe("page:settings");
  });

  it("moves a tab between panes", () => {
    useWorkspace.getState().openPage("welcome", { preview: false });
    useWorkspace.getState().openPage("settings", { preview: false });
    useWorkspace.getState().splitTab("page:settings", "row");
    useWorkspace.getState().moveTab("page:welcome", state().panes[1]?.id ?? "");

    const next = useWorkspace.getState();
    expect(next.panes).toHaveLength(1);
    expect(next.panes[0]?.tabIds).toEqual(["page:settings", "page:welcome"]);
    expect(next.split).toBeNull();
  });

  it("collapses a pane when its last tab closes", () => {
    useWorkspace.getState().openPage("welcome", { preview: false });
    useWorkspace.getState().openPage("settings", { preview: false });
    useWorkspace.getState().splitTab("page:settings", "column");
    useWorkspace.getState().close("page:settings");

    const state = useWorkspace.getState();
    expect(state.panes).toHaveLength(1);
    expect(state.split).toBeNull();
  });

  it("merges panes when one is closed", () => {
    useWorkspace.getState().openPage("welcome", { preview: false });
    useWorkspace.getState().openPage("settings", { preview: false });
    useWorkspace.getState().splitTab("page:settings", "row");
    useWorkspace.getState().closePane(state().panes[0]?.id ?? "");

    const next = useWorkspace.getState();
    expect(next.panes).toHaveLength(1);
    expect(next.panes[0]?.tabIds).toContain("page:settings");
    expect(next.panes[0]?.tabIds).toContain("page:welcome");
  });

  it("drops unsupported kinds when hydrating", () => {
    useWorkspace
      .getState()
      .hydrate([
        record("page:welcome", "welcome"),
        record("host:a", "host", "a"),
        record("host:missing", "host"),
        record("terminal:1", "terminal"),
      ]);
    expect(useWorkspace.getState().tabs.map((tab) => tab.id)).toEqual(["page:welcome", "host:a"]);
  });

  it("restores a detached local file panel and its placement without restoring SSH sessions", () => {
    state().openSftp(session("s1", "Alpha"));
    state().retainFilePane(
      "sftp:s1",
      { source: { kind: "local" }, path: "C:\\work\\项目", ownerSessionId: "s1" },
      "This computer",
    );
    state().openPage("settings");
    state().splitTab("sftp:s1", "row", "after");
    const records = workspaceRecords();
    state().hydrate(records);
    const tab = state().tabs.find((item) => item.id === "sftp:s1");
    expect(tab?.filePane).toEqual({
      source: { kind: "local" },
      path: "C:\\work\\项目",
      ownerSessionId: "restored",
    });
    expect(state().panes).toHaveLength(2);
    expect(state().panes.find((pane) => pane.tabIds.includes("sftp:s1"))).toBeTruthy();
  });

  it("rejects malformed or relative local file pane paths in a snapshot", () => {
    const metadata = JSON.stringify({ version: 1, localFilePanes: { "files:bad": "../relative" } });
    state().hydrate([{ ...record("files:bad", "sftp"), state: metadata }]);
    expect(state().tabs).toEqual([]);
  });

  it("opens one tab per SSH session", () => {
    useWorkspace.getState().openTerminal(session("s1", "Alpha"));
    useWorkspace.getState().openTerminal(session("s1", "Alpha"));
    expect(useWorkspace.getState().tabs).toHaveLength(1);
    expect(useWorkspace.getState().activeId).toBe("terminal:s1");
  });

  it("closes editor tabs together with their session", () => {
    useWorkspace.setState({
      tabs: [
        { id: "editor:s1:/home/a.txt", kind: "editor", title: "a.txt", hostId: "a", pinned: false },
        { id: "page:welcome", kind: "welcome", title: "welcome", hostId: null, pinned: false },
      ],
      activeId: "editor:s1:/home/a.txt",
    });
    useWorkspace.getState().closeSession("s1");
    expect(useWorkspace.getState().tabs.map((tab) => tab.id)).toEqual(["page:welcome"]);
  });

  it("opens independent files tabs for one session and drops both on close", () => {
    useWorkspace.getState().openSftp(session("s1", "Alpha"));
    useWorkspace.getState().openSftp(session("s1", "Alpha"));
    expect(useWorkspace.getState().tabs).toHaveLength(2);
    expect(useWorkspace.getState().activeId).toMatch(/^sftp:s1:copy:/);
    useWorkspace.getState().closeSession("s1");
    expect(useWorkspace.getState().tabs).toHaveLength(0);
  });

  it("keeps a detached local file panel when its original SSH session closes", () => {
    useWorkspace.getState().openSftp(session("s1", "Alpha"));
    useWorkspace.getState().retainFilePane(
      "sftp:s1",
      {
        source: { kind: "local" },
        path: "C:\\work",
        ownerSessionId: "s1",
      },
      "This computer",
    );
    useWorkspace.getState().closeSession("s1");
    expect(useWorkspace.getState().tabs[0]?.filePane?.source).toEqual({ kind: "local" });
  });

  it("closes the tab when its session goes away", () => {
    useWorkspace.getState().openTerminal(session("s1", "Alpha"));
    useWorkspace.getState().openPage("welcome", { preview: false });
    useWorkspace.getState().closeSession("s1");
    expect(useWorkspace.getState().tabs.map((tab) => tab.kind)).toEqual(["welcome"]);
  });

  it("ensures a welcome tab only when empty", () => {
    useWorkspace.getState().ensureWelcome();
    useWorkspace.getState().ensureWelcome();
    expect(useWorkspace.getState().tabs).toHaveLength(1);
  });
});

describe("split placement", () => {
  it("puts the dropped tab before the remaining ones", () => {
    useWorkspace.getState().openTerminal(session("s1", "Alpha"));
    useWorkspace.getState().openSftp(session("s1", "Alpha"));
    useWorkspace.getState().splitTab("sftp:s1", "row", "before");
    const panes = useWorkspace.getState().panes;
    expect(panes).toHaveLength(2);
    expect(panes[0]?.tabIds).toEqual(["sftp:s1"]);
    expect(panes[1]?.tabIds).toEqual(["terminal:s1"]);
    expect(useWorkspace.getState().split).toBe("row");
  });

  it("does not destroy another pane when splitting a sole tab", () => {
    useWorkspace.getState().openTerminal(session("s2", "Beta"));
    useWorkspace.getState().openSftp(session("s2", "Beta"));
    useWorkspace.getState().splitTab("sftp:s2", "row");
    useWorkspace.getState().splitTab("terminal:s2", "column", "before");
    const panes = useWorkspace.getState().panes;
    expect(panes).toHaveLength(2);
    expect(panes.flatMap((item) => item.tabIds).sort()).toEqual(["sftp:s2", "terminal:s2"]);
    expect(useWorkspace.getState().split).toBe("row");
  });

  it("nests another split inside a specific group", () => {
    state().openPage("welcome", { preview: false });
    state().openPage("settings", { preview: false });
    state().openPage("about", { preview: false });
    state().splitTab("page:settings", "row");
    const first = state().panes[0]!;
    state().splitTab("page:about", "column", "before", first.id);
    expect(state().panes).toHaveLength(3);
    const layout = state().layout;
    expect(layout.kind).toBe("split");
    if (layout.kind !== "split") return;
    expect(layout.direction).toBe("row");
    expect(layout.first.kind).toBe("split");
    if (layout.first.kind === "split") expect(layout.first.direction).toBe("column");
    expect(
      state()
        .panes.flatMap((item) => item.tabIds)
        .sort(),
    ).toEqual(["page:about", "page:settings", "page:welcome"]);
  });

  it("activates the owning pane and preserves pinned status when reopening a tab", () => {
    state().openPage("welcome", { preview: false });
    state().openPage("settings", { preview: false });
    state().togglePin("page:settings");
    state().splitTab("page:settings", "row");
    const owner = state().activePaneId;
    state().activate("page:welcome");
    state().openPage("settings", { preview: false });
    expect(state().activePaneId).toBe(owner);
    expect(state().tabs.find((tab) => tab.id === "page:settings")?.pinned).toBe(true);
    expect(
      state().panes.every((item) => !item.activeId || item.tabIds.includes(item.activeId)),
    ).toBe(true);
  });

  it("restores nested layout, active tabs and displayed ordering", () => {
    state().openPage("welcome", { preview: false });
    state().openPage("settings", { preview: false });
    state().openPage("about", { preview: false });
    state().splitTab("page:settings", "row");
    state().splitTab("page:about", "column", "before", state().panes[0]!.id);
    const expected = {
      layout: state().layout,
      panes: state().panes,
      activePaneId: state().activePaneId,
    };
    const records = workspaceRecords();
    state().hydrate([]);
    state().hydrate(records);
    expect(state().layout).toEqual(expected.layout);
    expect(state().panes).toEqual(expected.panes);
    expect(state().activePaneId).toBe(expected.activePaneId);
  });

  it("keeps dirty editors on disconnect", () => {
    const id = "editor:s1:/a.txt";
    useEditors.setState({
      entries: {
        [id]: {
          tabId: id,
          sessionId: "s1",
          path: "/a.txt",
          name: "a.txt",
          content: "new",
          baseline: "old",
          loading: false,
          saving: false,
          error: null,
        },
      },
    });
    useWorkspace.setState({
      tabs: [{ id, kind: "editor", title: "a.txt", hostId: "a", pinned: false }],
      panes: [{ id: "pane-1", tabIds: [id], activeId: id }],
    });
    state().closeSession("s1");
    expect(state().tabs).toHaveLength(1);
    expect(useEditors.getState().entries[id]?.disconnected).toBe(true);
    expect(useEditors.getState().entries[id]?.content).toBe("new");
  });

  it("only closes other unpinned tabs in the requested group", () => {
    state().openPage("welcome", { preview: false });
    state().openPage("settings", { preview: false });
    state().openPage("about", { preview: false });
    state().splitTab("page:about", "row");
    state().closeOthers("page:welcome");
    expect(
      state()
        .tabs.map((tab) => tab.id)
        .sort(),
    ).toEqual(["page:about", "page:welcome"]);
  });

  it("asks once before closing a group of dirty editors", () => {
    const confirm = vi.fn();
    useDialogs.setState({ confirm });
    const id = "editor:s1:/a.txt";
    useEditors.setState({
      entries: {
        [id]: {
          tabId: id,
          sessionId: "s1",
          path: "/a.txt",
          name: "a.txt",
          content: "new",
          baseline: "old",
          loading: false,
          saving: false,
          error: null,
        },
      },
    });
    useWorkspace.setState({
      tabs: [{ id, kind: "editor", title: "a.txt", hostId: "a", pinned: false }],
      panes: [{ id: "pane-1", tabIds: [id], activeId: id }],
    });
    state().openPage("welcome", { preview: false });
    state().closeOthers("page:welcome");
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(state().tabs).toHaveLength(2);
    confirm.mock.calls[0]![0].onConfirm();
    expect(state().tabs.map((tab) => tab.id)).toEqual(["page:welcome"]);
    expect(useEditors.getState().entries[id]).toBeUndefined();
  });
});
