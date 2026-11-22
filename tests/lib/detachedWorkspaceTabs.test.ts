import { expect, it } from "vitest";
import { useWorkspace } from "@/store/workspace";
import {
  revealReturnedWorkspaceTabs,
  retainReturnableWorkspaceTabs,
} from "@/lib/panels/mainPresentation";
import {
  forgetDetachedWorkspaceTab,
  rememberDetachedWorkspaceTab,
} from "@/lib/panels/detachedWorkspaceTabs";

const tab = {
  id: "page:settings",
  kind: "settings" as const,
  title: "Settings",
  hostId: null,
  pinned: false,
  hidden: true,
};
function snapshot(generation: number, windowId = "main") {
  return {
    windows: [],
    transfers: [],
    panels: [{ panelId: tab.id, windowId, generation }],
  };
}

it("does not revive a detached tab from the stale pre-transfer snapshot", () => {
  forgetDetachedWorkspaceTab(tab.id);
  useWorkspace.setState({
    tabs: [tab],
    panes: [{ id: "pane", tabIds: [tab.id], activeId: tab.id }],
    activePaneId: "pane",
    activeId: tab.id,
    layout: { kind: "pane", paneId: "pane" },
  });
  rememberDetachedWorkspaceTab(tab.id, tab.id, 4);
  revealReturnedWorkspaceTabs(snapshot(4));
  expect(useWorkspace.getState().tabs[0]?.hidden).toBe(true);
});

it("reveals the tab only when its native lease returns with a new generation", () => {
  forgetDetachedWorkspaceTab(tab.id);
  useWorkspace.setState({
    tabs: [tab],
    panes: [{ id: "pane", tabIds: [tab.id], activeId: tab.id }],
    activePaneId: "pane",
    activeId: tab.id,
    layout: { kind: "pane", paneId: "pane" },
  });
  rememberDetachedWorkspaceTab(tab.id, tab.id, 4);
  revealReturnedWorkspaceTabs(snapshot(5));
  expect(useWorkspace.getState().tabs[0]?.hidden).toBeFalsy();
});

it("retains a hidden return target but drops bookkeeping after the tab closes", () => {
  forgetDetachedWorkspaceTab(tab.id);
  useWorkspace.setState({
    tabs: [tab],
    panes: [{ id: "pane", tabIds: [tab.id], activeId: tab.id }],
    activePaneId: "pane",
    activeId: tab.id,
    layout: { kind: "pane", paneId: "pane" },
  });
  rememberDetachedWorkspaceTab(tab.id, tab.id, 4);
  retainReturnableWorkspaceTabs([tab]);
  revealReturnedWorkspaceTabs(snapshot(4));
  expect(useWorkspace.getState().tabs[0]?.hidden).toBe(true);
  retainReturnableWorkspaceTabs([]);
  revealReturnedWorkspaceTabs(snapshot(5));
  expect(useWorkspace.getState().tabs[0]?.hidden).toBe(true);
});
