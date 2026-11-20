import { useNavigation } from "@/store/navigation";
import { useWorkspace } from "@/store/workspace";
import { usePlugins } from "@/store/plugins";
import { useFilePreview } from "@/store/filePreview";
import { panelPresentation } from "@/store/panelPresentation";
import { SIDEBAR_VIEWS, sidebarTabId, sidebarViewOf } from "@/lib/session/sidebarDock";
import { pluginSidebars, parsePluginSidebar } from "@/lib/plugins/sidebars";
import { panelLocation } from "./controller";

/** LOCAL coordinator layout metadata only. Public panel RPC reads the native
 * source-window projection, never this helper as a satellite representation. */
export function panelSnapshot() {
  const workspace = useWorkspace.getState();
  const navigation = useNavigation.getState();
  const ids = [
    ...SIDEBAR_VIEWS,
    ...pluginSidebars(usePlugins.getState().items).map((item) => item.view),
  ];
  return ids.map((view) => {
    const state = panelPresentation(view).getState();
    const location = panelLocation(view);
    const tab = workspace.tabs.find((item) => item.id === sidebarTabId(view));
    const visible =
      location === "workspace"
        ? !!tab && !tab.hidden && workspace.panes.some((pane) => pane.activeId === tab.id)
        : location === "floating"
          ? state.open
          : navigation.sidebarVisible && navigation.activeSidebar === view;
    const available = view !== "filePreview" || useFilePreview.getState().file !== null;
    return {
      id: view,
      windowId: "main",
      presentation: location,
      visible: visible && available,
      pinned: state.pinned,
      bounds: state.bounds ? { ...state.bounds } : null,
      available,
      presentations: ["sidebar", "workspace", "floating"] as const,
    };
  });
}

export function requirePanel(id: string) {
  const view = sidebarViewOf(`sidebar:${id}`);
  if (!view) throw new Error("invalid:panelId");
  const plugin = parsePluginSidebar(view);
  if (plugin && !pluginSidebars(usePlugins.getState().items).some((item) => item.view === view))
    throw new Error("panel.notFound");
  if (view === "filePreview" && !useFilePreview.getState().file)
    throw new Error("panel.unavailable");
  return view;
}
