// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { beforeEach, describe, expect, it, vi } from "vitest";

import { closeTab } from "@/lib/session/tabActions";
import { useDialogs } from "@/store/dialogs";
import { useEditors } from "@/store/editors";
import { useWorkspace, type WorkspaceTab } from "@/store/workspace";

const tab: WorkspaceTab = {
  id: "editor:s1:/home/a.txt",
  kind: "editor",
  title: "a.txt",
  hostId: "h1",
  pinned: false,
};

beforeEach(() => {
  useDialogs.setState({ confirm: vi.fn() });
  useEditors.setState({ entries: {} });
  useWorkspace.setState({
    tabs: [tab],
    panes: [{ id: "pane-1", tabIds: [tab.id], activeId: tab.id }],
    activePaneId: "pane-1",
    activeId: tab.id,
    split: null,
  });
});

describe("closeTab", () => {
  it("asks before closing an editor with unsaved changes", () => {
    useEditors.setState({
      entries: {
        [tab.id]: {
          tabId: tab.id,
          sessionId: "s1",
          path: "/home/a.txt",
          name: "a.txt",
          content: "changed",
          baseline: "original",
          loading: false,
          saving: false,
          error: null,
        },
      },
    });

    closeTab(tab);

    expect(useDialogs.getState().confirm).toHaveBeenCalledTimes(1);
    expect(useWorkspace.getState().tabs).toHaveLength(1);
  });

  it("closes a clean editor right away", () => {
    closeTab(tab);
    expect(useDialogs.getState().confirm).not.toHaveBeenCalled();
    expect(useWorkspace.getState().tabs).toHaveLength(0);
  });
});
