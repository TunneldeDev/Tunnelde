import { ForwardingPanel } from "@/features/forwarding/ForwardingPanel";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { HostTree } from "@/components/layout/HostTree";
import { PluginsSidebar } from "@/features/plugins/PluginsSidebar";
import { TrustedHostsSidebar } from "@/features/settings/TrustedHostsSidebar";
import { SIDEBAR_MIME, sidebarTabId, sidebarViewOf, TAB_MIME } from "@/lib/session/sidebarDock";
import { useNavigation, type SidebarView } from "@/store/navigation";
import { useWorkspace } from "@/store/workspace";
import { PluginSidebarPanel } from "@/features/plugins/PluginSidebarPanel";
import { parsePluginSidebar, type PluginSidebarView } from "@/lib/plugins/sidebars";

const containers = new Map<SidebarView, HTMLDivElement>();
function containerFor(view: SidebarView): HTMLDivElement {
  let container = containers.get(view);
  if (!container) {
    container = document.createElement("div");
    container.className = "sidebar-panel";
    container.id = `sidebar-${view}`;
    container.dataset.sidebarPanel = view;
    containers.set(view, container);
  }
  return container;
}

/** Move the existing DOM container; the list's React owner never changes. */
export function SidebarMount({ view, docked = false }: { view: SidebarView; docked?: boolean }) {
  const mount = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const target = mount.current;
    if (!target) return;
    const container = containerFor(view);
    if (container.parentElement !== target) target.append(container);
  }, [view, docked]);
  return (
    <div
      className="sidebar-dock-mount"
      data-sidebar-slot={view}
      data-docked={docked || undefined}
      ref={mount}
    />
  );
}

function SidebarSlot({ view, hidden }: { view: SidebarView; hidden: boolean }) {
  const slot = useRef<HTMLDivElement>(null);
  const [over, setOver] = useState(false);
  useEffect(() => {
    const target = slot.current;
    if (!target) return;
    const dragover = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes(SIDEBAR_MIME)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "move";
      setOver(true);
    };
    const dragleave = (event: DragEvent) => {
      if (!(event.relatedTarget instanceof Node) || !target.contains(event.relatedTarget))
        setOver(false);
    };
    const drop = (event: DragEvent) => {
      const view = sidebarViewOf(event.dataTransfer?.getData(TAB_MIME) ?? "");
      if (!view) return;
      event.preventDefault();
      event.stopPropagation();
      setOver(false);
      useWorkspace.getState().returnSidebar(view);
    };
    target.addEventListener("dragover", dragover);
    target.addEventListener("dragleave", dragleave);
    target.addEventListener("drop", drop);
    return () => {
      target.removeEventListener("dragover", dragover);
      target.removeEventListener("dragleave", dragleave);
      target.removeEventListener("drop", drop);
    };
  }, []);
  return (
    <div ref={slot} className={`sidebar-view${over ? " is-return-target" : ""}`} hidden={hidden}>
      <SidebarMount view={view} />
    </div>
  );
}

export function SidebarArea() {
  const visited = useNavigation((state) => state.visitedSidebars);
  const visible = useNavigation((state) => state.sidebarVisible);
  const active = useNavigation((state) => state.activeSidebar);
  const tabs = useWorkspace((state) => state.tabs);
  return visited
    .filter((view) => !tabs.some((tab) => tab.id === sidebarTabId(view)))
    .map((view) => <SidebarSlot key={view} view={view} hidden={!visible || active !== view} />);
}

export function SidebarContents() {
  const visited = useNavigation((state) => state.visitedSidebars);
  const sidebarVisible = useNavigation((state) => state.sidebarVisible);
  const activeSidebar = useNavigation((state) => state.activeSidebar);
  const tabs = useWorkspace((state) => state.tabs);
  const panes = useWorkspace((state) => state.panes);
  const docked = useMemo(
    () =>
      tabs.flatMap((tab) => {
        const view = tab.kind === "sidebar" ? sidebarViewOf(tab.id) : null;
        return view ? [view] : [];
      }),
    [tabs],
  );
  useEffect(() => {
    for (const view of docked) useNavigation.getState().rememberSidebar(view);
  }, [docked]);
  const views = [...new Set([...visited, ...docked])];
  useLayoutEffect(() => {
    for (const view of views) {
      const id = sidebarTabId(view);
      const owner = panes.find((pane) => pane.tabIds.includes(id));
      containerFor(view).hidden = owner
        ? owner.activeId !== id || !!tabs.find((tab) => tab.id === id)?.hidden
        : !sidebarVisible || activeSidebar !== view;
    }
  });
  return views.map((view) => {
    const owner = panes.find((pane) => pane.tabIds.includes(sidebarTabId(view)));
    const active = owner
      ? owner.activeId === sidebarTabId(view) &&
        !tabs.find((tab) => tab.id === sidebarTabId(view))?.hidden
      : sidebarVisible && activeSidebar === view;
    return createPortal(
      view === "hosts" ? (
        <HostTree />
      ) : view === "forwarding" ? (
        <ForwardingPanel />
      ) : view === "plugins" ? (
        <PluginsSidebar />
      ) : parsePluginSidebar(view) ? (
        <PluginSidebarPanel view={view as PluginSidebarView} />
      ) : (
        <TrustedHostsSidebar active={active} />
      ),
      containerFor(view),
      view,
    );
  });
}
