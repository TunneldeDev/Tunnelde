// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Host, SshSession, TabRecord } from "@/lib/api/types";
import { useWorkspace, workspaceRecords } from "@/store/workspace";
import { useEditors } from "@/store/editors";
import { useDialogs } from "@/store/dialogs";

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

beforeEach(() => {
  useWorkspace.setState({
    tabs: [],
    panes: [{ id: "pane-1", tabIds: [], activeId: null }],
    activePaneId: "pane-1",
    activeId: null,
    split: null,
    layout: { kind: "pane", paneId: "pane-1" },
  });
});

describe("workspace tabs", () => {
  it("opens a page once", () => {
    useWorkspace.getState().openPage("settings");
    useWorkspace.getState().openPage("settings");
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
    useWorkspace.getState().openPage("welcome");
    useWorkspace.getState().openPage("settings");
    useWorkspace.getState().close("page:settings");
    expect(useWorkspace.getState().activeId).toBe("page:welcome");
  });

  it("reorders tabs inside the active pane", () => {
    useWorkspace.getState().openPage("welcome");
    useWorkspace.getState().openPage("settings");
    useWorkspace.getState().reorder(0, 1);
    const state = useWorkspace.getState();
    const kinds = (state.panes[0]?.tabIds ?? []).map(
      (id) => state.tabs.find((tab) => tab.id === id)?.kind,
    );
    expect(kinds).toEqual(["settings", "welcome"]);
  });

  it("splits a tab into a second pane", () => {
    useWorkspace.getState().openPage("welcome");
    useWorkspace.getState().openPage("settings");
    useWorkspace.getState().splitTab("page:settings", "row");

    const state = useWorkspace.getState();
    expect(state.panes).toHaveLength(2);
    expect(state.split).toBe("row");
    expect(state.panes[1]?.tabIds).toEqual(["page:settings"]);
    expect(state.activeId).toBe("page:settings");
  });

  it("moves a tab between panes", () => {
    useWorkspace.getState().openPage("welcome");
    useWorkspace.getState().openPage("settings");
    useWorkspace.getState().splitTab("page:settings", "row");
    useWorkspace.getState().moveTab("page:welcome", state().panes[1]?.id ?? "");

    const next = useWorkspace.getState();
    expect(next.panes).toHaveLength(1);
    expect(next.panes[0]?.tabIds).toEqual(["page:settings", "page:welcome"]);
    expect(next.split).toBeNull();
  });

  it("collapses a pane when its last tab closes", () => {
    useWorkspace.getState().openPage("welcome");
    useWorkspace.getState().openPage("settings");
    useWorkspace.getState().splitTab("page:settings", "column");
    useWorkspace.getState().close("page:settings");

    const state = useWorkspace.getState();
    expect(state.panes).toHaveLength(1);
    expect(state.split).toBeNull();
  });

  it("merges panes when one is closed", () => {
    useWorkspace.getState().openPage("welcome");
    useWorkspace.getState().openPage("settings");
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

  it("opens one files tab per session and drops it on close", () => {
    useWorkspace.getState().openSftp(session("s1", "Alpha"));
    useWorkspace.getState().openSftp(session("s1", "Alpha"));
    expect(useWorkspace.getState().tabs).toHaveLength(1);
    expect(useWorkspace.getState().activeId).toBe("sftp:s1");
    useWorkspace.getState().closeSession("s1");
    expect(useWorkspace.getState().tabs).toHaveLength(0);
  });

  it("closes the tab when its session goes away", () => {
    useWorkspace.getState().openTerminal(session("s1", "Alpha"));
    useWorkspace.getState().openPage("welcome");
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
    state().openPage("welcome");
    state().openPage("settings");
    state().openPage("about");
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
    state().openPage("welcome");
    state().openPage("settings");
    state().togglePin("page:settings");
    state().splitTab("page:settings", "row");
    const owner = state().activePaneId;
    state().activate("page:welcome");
    state().openPage("settings");
    expect(state().activePaneId).toBe(owner);
    expect(state().tabs.find((tab) => tab.id === "page:settings")?.pinned).toBe(true);
    expect(
      state().panes.every((item) => !item.activeId || item.tabIds.includes(item.activeId)),
    ).toBe(true);
  });

  it("restores nested layout, active tabs and displayed ordering", () => {
    state().openPage("welcome");
    state().openPage("settings");
    state().openPage("about");
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
    state().openPage("welcome");
    state().openPage("settings");
    state().openPage("about");
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
    state().openPage("welcome");
    state().closeOthers("page:welcome");
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(state().tabs).toHaveLength(2);
    confirm.mock.calls[0]![0].onConfirm();
    expect(state().tabs.map((tab) => tab.id)).toEqual(["page:welcome"]);
    expect(useEditors.getState().entries[id]).toBeUndefined();
  });
});
