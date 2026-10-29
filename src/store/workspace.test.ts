// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { beforeEach, describe, expect, it } from "vitest";

import type { Host, TabRecord } from "@/lib/types";
import { useWorkspace } from "@/store/workspace";

const host = (id: string, name: string): Host => ({
  id,
  groupId: null,
  name,
  host: `${id}.example.com`,
  port: 22,
  username: "root",
  authMethod: "password",
  favorite: false,
  color: null,
  tags: [],
  note: null,
  lastUsedAt: null,
  createdAt: 0,
  updatedAt: 0,
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
  useWorkspace.setState({ tabs: [], activeId: null });
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

  it("reorders tabs", () => {
    useWorkspace.getState().openPage("welcome");
    useWorkspace.getState().openPage("settings");
    useWorkspace.getState().reorder(0, 1);
    expect(useWorkspace.getState().tabs.map((tab) => tab.kind)).toEqual(["settings", "welcome"]);
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

  it("ensures a welcome tab only when empty", () => {
    useWorkspace.getState().ensureWelcome();
    useWorkspace.getState().ensureWelcome();
    expect(useWorkspace.getState().tabs).toHaveLength(1);
  });
});
