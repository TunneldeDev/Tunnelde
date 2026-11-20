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
