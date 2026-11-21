import { useEditorWindowRegistrations } from "@/features/editor/editorWindowRegistration";
import { useEditors } from "@/store/editors";
import { useDialogs } from "@/store/dialogs";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("@/lib/api/ipc", () => ({ api: {} }));
import { createMainPanelPresentation } from "@/lib/panels/mainPresentation";
import { useWorkspace } from "@/store/workspace";
import { usePanelWindows } from "@/store/panelWindows";
afterEach(() => {
  usePanelWindows.setState({ available: false });
});
it.each(["terminal", "sftp"] as const)(
  "publishes staged %s workspace presentation before main acquires ownership",
  (kind) => {
    const id = `${kind}:qa`;
    useWorkspace.setState({
      tabs: [{ id, kind, title: "QA", hostId: null, pinned: false }],
      panes: [{ id: "pane", tabIds: [id], activeId: id }],
    });
    usePanelWindows.setState({
      available: true,
      snapshot: {
        windows: [],
        panels: [{ panelId: id, windowId: "target", generation: 2 }],
        transfers: [],
      },
    });
    const host = createMainPanelPresentation();
    expect(host.read().find((row) => row.id === id)).toBeUndefined();
    expect(host.readStaged(id)).toMatchObject({
      id,
      windowId: "main",
      available: true,
      presentation: "workspace",
      presentations: ["workspace", "floating"],
    });
    expect(() => host.reveal(id)).toThrow("panel.window.staleOwner");
    usePanelWindows.setState({
      snapshot: {
        windows: [],
        panels: [{ panelId: id, windowId: "main", generation: 3 }],
        transfers: [],
      },
    });
    expect(host.read().find((row) => row.id === id)?.available).toBe(true);
    host.set(id, "floating");
    expect(useWorkspace.getState().panes.find((p) => p.tabIds.includes(id))?.floating).toBeTruthy();
    host.set(id, "workspace");
    expect(useWorkspace.getState().panes.find((p) => p.tabIds.includes(id))?.floating).toBeFalsy();
  },
);

it("maps an editor's opaque native ID back to its workspace tab and retains pending discard consent", () => {
  const tabId = "editor-local:/C:/long/file.txt",
    panelId = "editor-view:00000000-0000-4000-8000-000000000002";
  useEditorWindowRegistrations.setState({ entries: new Map([[tabId, panelId]]) });
  useWorkspace.setState({
    tabs: [{ id: tabId, kind: "editor", title: "file.txt", hostId: null, pinned: false }],
    panes: [{ id: "editor-pane", tabIds: [tabId], activeId: tabId }],
  });
  useEditors.setState({
    entries: {
      [tabId]: {
        tabId,
        sessionId: null,
        path: "/C:/long/file.txt",
        name: "file.txt",
        content: "draft",
        baseline: "original",
        loading: false,
        saving: false,
        error: null,
      },
    },
  });
  usePanelWindows.setState({
    available: true,
    snapshot: {
      windows: [],
      transfers: [],
      panels: [{ panelId, windowId: "main", generation: 8 }],
    },
  });
  const host = createMainPanelPresentation();
  expect(host.read().find((row) => row.id === panelId)?.visible).toBe(true);
  host.set(panelId, "floating");
  expect(
    useWorkspace.getState().panes.find((p) => p.tabIds.includes(tabId))?.floating,
  ).toBeTruthy();
  host.set(panelId, "workspace");
  host.close(panelId);
  expect(useWorkspace.getState().tabs.some((t) => t.id === tabId)).toBe(true);
  expect(host.read().find((row) => row.id === panelId)).toMatchObject({
    visible: true,
    available: true,
  });
  useDialogs.getState().close();
  expect(host.read().find((row) => row.id === panelId)?.visible).toBe(true);
  useEditors.getState().discard(tabId);
});
