import { usePanelWindows } from "@/store/panelWindows";
import { windowViews } from "./windowViews";
import { reportError } from "@/lib/diagnostics";
import { preservePanelFocus } from "./focus";
import { useNavigation, type SidebarView } from "@/store/navigation";
import { useWorkspace } from "@/store/workspace";
import { panelPresentation } from "@/store/panelPresentation";
import { sidebarTabId } from "@/lib/session/sidebarDock";

import type { PanelPresentation } from "@/store/panelPresentation";
export type { PanelPresentation } from "@/store/panelPresentation";

export function panelLocation(view: SidebarView): PanelPresentation {
  if (useWorkspace.getState().tabs.some((tab) => tab.id === sidebarTabId(view))) return "workspace";
  const state = panelPresentation(view).getState();
  return state.open || state.preferred === "floating" ? "floating" : "sidebar";
}

export function setPanelLocation(view: SidebarView, location: PanelPresentation) {
  const floating = panelPresentation(view).getState();
  preservePanelFocus(view);
  if (location === "floating") {
    const workspace = useWorkspace.getState();
    const id = sidebarTabId(view);
    if (workspace.tabs.some((tab) => tab.id === id)) workspace.returnSidebar(view);
    if (useNavigation.getState().activeSidebar === view)
      useNavigation.setState({ sidebarVisible: false });
    useNavigation.getState().rememberSidebar(view);
    floating.setPreferred("floating");
    floating.show();
  } else {
    floating.close();
    floating.setPreferred(location);
    if (location === "workspace") useWorkspace.getState().openSidebar(view);
    else useWorkspace.getState().returnSidebar(view);
  }
}

/** A close hides presentation, never stops the resources displayed by the panel. */
export function closePanel(view: SidebarView) {
  panelPresentation(view).getState().close();
  const workspace = useWorkspace.getState();
  if (workspace.tabs.some((tab) => tab.id === sidebarTabId(view))) {
    workspace.close(sidebarTabId(view));
  } else if (useNavigation.getState().activeSidebar === view) {
    useNavigation.setState({ sidebarVisible: false });
  }
}

function focusRemotePanel(view: SidebarView) {
  const { available, snapshot, windowId } = usePanelWindows.getState();
  const owner = snapshot.panels.find((panel) => panel.panelId === view);
  if (!available || !owner || owner.windowId === windowId) return false;
  const client = windowViews()?.client;
  if (!client) return false;
  void client.focus(view).catch((error) => reportError("panels.windows", "focus", error));
  return true;
}

export function revealPanel(view: SidebarView, fallback: PanelPresentation = "sidebar") {
  if (focusRemotePanel(view)) return;
  const workspace = useWorkspace.getState();
  if (workspace.tabs.some((tab) => tab.id === sidebarTabId(view))) {
    workspace.activate(sidebarTabId(view));
  } else if (panelPresentation(view).getState().open) {
    panelPresentation(view).getState().raise();
  } else if (
    useNavigation.getState().sidebarVisible &&
    useNavigation.getState().activeSidebar === view
  ) {
    // Already visible. Leave the current location alone.
  } else {
    setPanelLocation(view, panelPresentation(view).getState().preferred ?? fallback);
  }
}

/** Status/navigation entry semantics shared by panels regardless of presentation. */
export function togglePanel(view: SidebarView, fallback: PanelPresentation = "sidebar") {
  if (focusRemotePanel(view)) return;
  const workspace = useWorkspace.getState();
  if (workspace.tabs.some((tab) => tab.id === sidebarTabId(view)))
    workspace.toggleDockedSidebar(view);
  else if (panelPresentation(view).getState().open) closePanel(view);
  else if (
    useNavigation.getState().sidebarVisible &&
    useNavigation.getState().activeSidebar === view
  )
    closePanel(view);
  else revealPanel(view, fallback);
}
