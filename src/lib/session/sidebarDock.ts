import type { BuiltinSidebarView, SidebarView } from "@/store/navigation";
import { parsePluginSidebar, pluginSidebars } from "@/lib/plugins/sidebars";
import { usePlugins } from "@/store/plugins";
import type { TFunction } from "i18next";

export const TAB_MIME = "application/x-tunnelde-tab";
export const SIDEBAR_MIME = "application/x-tunnelde-sidebar";
export const SIDEBAR_VIEWS: BuiltinSidebarView[] = ["hosts", "knownHosts", "plugins"];
export const SIDEBAR_LABELS = {
  hosts: "sidebar.hosts",
  knownHosts: "settings.knownHosts",
  plugins: "settings.plugins",
} as const satisfies Record<BuiltinSidebarView, string>;
export const sidebarTabId = (view: SidebarView): string => `sidebar:${view}`;

export function sidebarLabel(view: SidebarView, t: TFunction): string {
  return view in SIDEBAR_LABELS
    ? t(SIDEBAR_LABELS[view as BuiltinSidebarView])
    : sidebarTitle(view);
}

/** Built-ins return translation keys; plugin titles are rendered literally. */
export function sidebarTitle(view: SidebarView): string {
  if (view in SIDEBAR_LABELS) return SIDEBAR_LABELS[view as BuiltinSidebarView];
  return (
    pluginSidebars(usePlugins.getState().items).find((item) => item.view === view)?.title ??
    parsePluginSidebar(view)?.viewId ??
    view
  );
}

export function sidebarViewOf(id: string): SidebarView | null {
  if (!id.startsWith("sidebar:")) return null;
  const view = id.slice("sidebar:".length) as SidebarView;
  return SIDEBAR_VIEWS.includes(view as BuiltinSidebarView) || parsePluginSidebar(view)
    ? view
    : null;
}
