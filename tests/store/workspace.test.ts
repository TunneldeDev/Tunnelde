// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { beforeEach, describe, expect, it } from "vitest";

import type { Host, SshSession, TabRecord } from "@/lib/api/types";
import { useWorkspace } from "@/store/workspace";

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

  it("falls back to the second pane when one already exists", () => {
    useWorkspace.getState().openTerminal(session("s2", "Beta"));
    useWorkspace.getState().openSftp(session("s2", "Beta"));
    useWorkspace.getState().splitTab("sftp:s2", "row");
    useWorkspace.getState().splitTab("terminal:s2", "column", "before");
    const panes = useWorkspace.getState().panes;
    expect(panes).toHaveLength(1);
    expect(panes[0]?.tabIds.sort()).toEqual(["sftp:s2", "terminal:s2"]);
    expect(useWorkspace.getState().split).toBeNull();
  });
});