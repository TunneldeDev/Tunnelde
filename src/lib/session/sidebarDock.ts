import type { SidebarView } from "@/store/navigation";

export const TAB_MIME = "application/x-tunnelde-tab";
export const SIDEBAR_MIME = "application/x-tunnelde-sidebar";
export const SIDEBAR_VIEWS: SidebarView[] = ["hosts", "knownHosts", "plugins"];
export const SIDEBAR_LABELS = {
  hosts: "sidebar.hosts",
  knownHosts: "settings.knownHosts",
  plugins: "settings.plugins",
} as const satisfies Record<SidebarView, string>;
export const sidebarTabId = (view: SidebarView): string => `sidebar:${view}`;

export function sidebarViewOf(id: string): SidebarView | null {
  if (!id.startsWith("sidebar:")) return null;
  const view = id.slice("sidebar:".length) as SidebarView;
  return SIDEBAR_VIEWS.includes(view) ? view : null;
}
