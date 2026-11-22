import { closeTab } from "@/lib/session/tabActions";
import {
  canonicalWorkspacePanelId,
  nativeWorkspaceTabId,
} from "@/features/editor/editorWindowRegistration";
import { useWorkspace } from "@/store/workspace";
import type { SourcePanelMetadata } from "./sourcePresentation";
import type { NativePanelSnapshot } from "./windowProtocol";
import { usePanelWindows } from "@/store/panelWindows";
import { useFilePreview } from "@/store/filePreview";
import { panelSnapshot, requirePanel } from "./snapshot";
import { subscribePanels } from "./observation";
import { closePanel, revealPanel, setPanelLocation } from "./controller";
import type { SourcePanelPresentation } from "./sourcePresentation";

/** Restore only workspace pages whose live native owner returned to main.
 * Sidebar tabs have independent hide semantics and are deliberately excluded. */
export function revealReturnedWorkspaceTabs(snapshot: NativePanelSnapshot) {
  const owned = new Set(
    snapshot.panels.filter((panel) => panel.windowId === "main").map((panel) => panel.panelId),
  );
  const workspace = useWorkspace.getState();
  for (const tab of workspace.tabs) {
    if (
      tab.hidden &&
      ["terminal", "sftp", "editor", "host", "settings", "updates"].includes(tab.kind) &&
      owned.has(canonicalWorkspacePanelId(tab.id))
    )
      workspace.activate(tab.id);
  }
}

/** Main-document adapter. Never use this to read or mutate a satellite's slot;
 * the native source router must select the exact current document first. */
export function createMainPanelPresentation(): SourcePanelPresentation {
  const closed = new Map<string, SourcePanelMetadata>();
  const workspaceTab = (id: string) =>
    useWorkspace
      .getState()
      .tabs.find(
        (tab) =>
          (tab.kind === "terminal" ||
            tab.kind === "sftp" ||
            tab.kind === "editor" ||
            tab.kind === "host" ||
            tab.kind === "settings" ||
            tab.kind === "updates") &&
          tab.id === nativeWorkspaceTabId(id),
      );
  const workspaceRows = (): SourcePanelMetadata[] => {
    const state = useWorkspace.getState();
    return state.tabs
      .filter(
        (tab) =>
          tab.kind === "terminal" ||
          tab.kind === "sftp" ||
          tab.kind === "editor" ||
          tab.kind === "host" ||
          tab.kind === "settings" ||
          tab.kind === "updates",
      )
      .map((tab) => {
        const pane = state.panes.find((pane) => pane.tabIds.includes(tab.id));
        return {
          id: canonicalWorkspacePanelId(tab.id),
          windowId: "main",
          presentation: pane?.floating ? "floating" : "workspace",
          visible: !!pane && pane.activeId === tab.id && !tab.hidden,
          pinned: tab.pinned,
          bounds: pane?.floating?.bounds ?? null,
          available: true,
          presentations: ["workspace", "floating"],
        };
      });
  };
  const local = (id: string) => {
    const state = usePanelWindows.getState();
    if (
      state.available &&
      !state.snapshot.panels.some((panel) => panel.panelId === id && panel.windowId === "main")
    )
      throw new Error("panel.window.staleOwner");
    return workspaceTab(id) ? id : requirePanel(id);
  };
  const read = () => {
    const state = usePanelWindows.getState();
    return [...panelSnapshot(), ...workspaceRows(), ...closed.values()].filter(
      (panel) =>
        !state.available ||
        state.snapshot.panels.some(
          (lease) => lease.panelId === panel.id && lease.windowId === "main",
        ),
    );
  };
  return {
    read,
    readStaged: (id) => [...panelSnapshot(), ...workspaceRows()].find((panel) => panel.id === id),
    set(id, presentation) {
      local(id);
      if (workspaceTab(id)) {
        if (presentation === "floating") useWorkspace.getState().floatTab(nativeWorkspaceTabId(id));
        else if (presentation === "workspace") {
          const pane = useWorkspace
            .getState()
            .panes.find((pane) => pane.tabIds.includes(nativeWorkspaceTabId(id)));
          if (pane?.floating) useWorkspace.getState().dockPane(pane.id);
          useWorkspace.getState().activate(nativeWorkspaceTabId(id));
        } else throw new Error("panel.window.unsupportedPresentation");
        return read().find((panel) => panel.id === id)!;
      }
      const view = requirePanel(id);
      if (!["sidebar", "workspace", "floating"].includes(presentation))
        throw new Error("panel.window.unsupportedPresentation");
      if (view === "filePreview" && useFilePreview.getState().presentation === "quickLook")
        useFilePreview.getState().dock();
      setPanelLocation(view, presentation);
      return read().find((panel) => panel.id === id)!;
    },
    close: (id) => {
      local(id);
      if (workspaceTab(id)) {
        const row = workspaceRows().find((row) => row.id === id)!;
        closeTab(workspaceTab(id)!);
        // Dirty editors keep their tab until explicit discard consent. Never
        // publish a fictitious closed slot while that dialog is pending/cancelled.
        if (!workspaceTab(id)) closed.set(id, { ...row, visible: false, available: false });
      } else closePanel(requirePanel(id));
    },
    reveal: (id) => {
      local(id);
      if (workspaceTab(id)) useWorkspace.getState().activate(nativeWorkspaceTabId(id));
      else revealPanel(requirePanel(id));
    },
    subscribe: (changed) => {
      const stop = subscribePanels(changed);
      const stopWindows = usePanelWindows.subscribe(changed);
      const stopWorkspace = useWorkspace.subscribe(changed);
      return () => {
        stop();
        stopWindows();
        stopWorkspace();
      };
    },
  };
}
