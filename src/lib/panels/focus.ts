import type { SidebarView } from "@/store/navigation";

const requests = new Map<SidebarView, HTMLElement>();
export function preservePanelFocus(view: SidebarView) {
  const focused = document.activeElement;
  if (
    focused instanceof HTMLElement &&
    document.getElementById(`sidebar-${view}`)?.contains(focused)
  )
    requests.set(view, focused);
}
export function restorePanelFocus(view: SidebarView): boolean {
  const focused = requests.get(view);
  requests.delete(view);
  if (!focused?.isConnected) return false;
  focused.focus({ preventScroll: true });
  return document.activeElement === focused;
}
