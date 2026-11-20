import { canFloatPluginView } from "@/lib/plugins/presentation";
import { preservePanelFocus } from "./focus";
import { useNavigation, type SidebarView } from "@/store/navigation";
import { useWorkspace } from "@/store/workspace";
import { panelPresentation } from "@/store/panelPresentation";
import { sidebarTabId } from "@/lib/session/sidebarDock";

import type { PanelPresentation } from "@/store/panelPresentation";
export type { PanelPresentation } from "@/store/panelPresentation";

export function panelLocation(view: SidebarView): PanelPresentation {
  if (useWorkspace.getState().tabs.some((tab) => tab.id === sidebarTabId(view))) return "workspace";
  if (!canFloatPluginView(view)) return "sidebar";
  const state = panelPresentation(view).getState();
  return state.open || state.preferred === "floating" ? "floating" : "sidebar";
}

export function setPanelLocation(view: SidebarView, location: PanelPresentation) {
  if (location === "floating" && !canFloatPluginView(view))
    throw new Error("panel.presentationUnsupported");
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

export function revealPanel(view: SidebarView, fallback: PanelPresentation = "sidebar") {
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
    const preferred = panelPresentation(view).getState().preferred ?? fallback;
    setPanelLocation(
      view,
      preferred === "floating" && !canFloatPluginView(view) ? "sidebar" : preferred,
    );
  }
}

/** Status/navigation entry semantics shared by panels regardless of presentation. */
export function togglePanel(view: SidebarView, fallback: PanelPresentation = "sidebar") {
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
