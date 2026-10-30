// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "@/i18n/i18n";
import { HostTree } from "@/components/layout/HostTree";
import type { Host } from "@/lib/api/types";
import { useDialogs } from "@/store/dialogs";
import { useHosts } from "@/store/hosts";
import { useWorkspace } from "@/store/workspace";

const host = (id: string, name: string, sortOrder: number): Host => ({
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
  sortOrder,
  lastUsedAt: null,
  createdAt: 0,
  updatedAt: 0,
});

beforeEach(() => {
  useHosts.setState({ hosts: [host("a", "alpha", 0), host("b", "beta", 1)], groups: [] });
  useDialogs.setState({ openHost: vi.fn(), openGroup: vi.fn(), confirm: vi.fn() });
  useWorkspace.setState({
    tabs: [],
    panes: [{ id: "pane-1", tabIds: [], activeId: null }],
    activePaneId: "pane-1",
    activeId: null,
    split: null,
  });
});

describe("HostTree keyboard navigation", () => {
  it("moves the active row with the arrow keys and opens it with Enter", () => {
    render(<HostTree />);

    const tree = screen.getByRole("tree");
    tree.focus();
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    expect(tree.getAttribute("aria-activedescendant")).toBe("host-a");

    fireEvent.keyDown(tree, { key: "ArrowDown" });
    expect(tree.getAttribute("aria-activedescendant")).toBe("host-b");

    fireEvent.keyDown(tree, { key: "Enter" });
    expect(useWorkspace.getState().tabs.map((tab) => tab.id)).toContain("host:b");
  });

  it("wraps to the last row when nothing is selected yet", () => {
    render(<HostTree />);
    const tree = screen.getByRole("tree");
    tree.focus();
    fireEvent.keyDown(tree, { key: "ArrowUp" });
    expect(tree.getAttribute("aria-activedescendant")).toBe("host-b");

    fireEvent.keyDown(tree, { key: "Home" });
    expect(tree.getAttribute("aria-activedescendant")).toBe("host-a");
  });
});
