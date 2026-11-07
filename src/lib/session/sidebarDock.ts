import type { BuiltinSidebarView, SidebarView } from "@/store/navigation";
import { parsePluginSidebar, pluginSidebars } from "@/lib/plugins/sidebars";
import { usePlugins } from "@/store/plugins";
import type { TFunction } from "i18next";

export const TAB_MIME = "application/x-tunnelde-tab";
export const SIDEBAR_MIME = "application/x-tunnelde-sidebar";
export const SIDEBAR_VIEWS: BuiltinSidebarView[] = [
  "hosts",
  "knownHosts",
  "plugins",
  "forwarding",
  "tasks",
];
export const SIDEBAR_LABELS = {
  hosts: "sidebar.hosts",
  forwarding: "forward.title",
  knownHosts: "settings.knownHosts",
  plugins: "settings.plugins",
  tasks: "tasks.title",
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

export interface LayoutSize {
  width: number;
  height: number;
}
const measurableSize = (element: Element | null): LayoutSize | null => {
  const rect = element?.getBoundingClientRect();
  return rect && rect.width > 0 && rect.height > 0
    ? { width: rect.width, height: rect.height }
    : null;
};

/** Measure before moving a sidebar's stable DOM container to its new group. */
export function measureSidebar(view: SidebarView): (LayoutSize & { fromSidebar: boolean }) | null {
  if (typeof document === "undefined") return null;
  const panel = Array.from(document.querySelectorAll<HTMLElement>("[data-sidebar-panel]")).find(
    (element) => element.dataset.sidebarPanel === view,
  );
  const sidebar = panel?.closest(".sidebar-view") ?? null;
  const size = measurableSize(panel?.closest(".pane") ?? sidebar ?? panel ?? null);
  return size ? { ...size, fromSidebar: !!sidebar } : null;
}

export function measureWorkspace(): LayoutSize | null {
  return typeof document === "undefined"
    ? null
    : measurableSize(document.querySelector(".workspace"));
}

export function measurePane(paneId: string): LayoutSize | null {
  if (typeof document === "undefined") return null;
  const pane = Array.from(document.querySelectorAll<HTMLElement>("[data-pane-id]")).find(
    (element) => element.dataset.paneId === paneId,
  );
  return measurableSize(pane ?? null);
}
