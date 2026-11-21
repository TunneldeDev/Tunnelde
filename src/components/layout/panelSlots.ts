import type { SidebarView } from "@/store/navigation";

const actions = new Map<SidebarView, HTMLDivElement>();
export function panelActionsContainer(view: SidebarView) {
  let node = actions.get(view);
  if (!node) {
    node = document.createElement("div");
    node.className = "workbench-panel__business-actions";
    actions.set(view, node);
  }
  return node;
}
