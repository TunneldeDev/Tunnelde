import { panelLocation } from "@/lib/panels/controller";
import { ForwardingPanel } from "@/features/forwarding/ForwardingPanel";
import { OutputPanel } from "@/features/output/OutputPanel";
import { WorkbenchPanel } from "./WorkbenchPanel";
import { ConnectionDetails } from "./ConnectionStatus";
import { usePanelPresentations, panelPresentation } from "@/store/panelPresentation";
import { DockedBackgroundTasks } from "@/features/tasks/BackgroundTasks";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { HostTree } from "@/components/layout/HostTree";
import { ProviderSurface } from "./ProviderSurface";
import { PluginsSidebar } from "@/features/plugins/PluginsSidebar";
import { TrustedHostsSidebar } from "@/features/settings/TrustedHostsSidebar";
import { SIDEBAR_MIME, sidebarTabId, sidebarViewOf, TAB_MIME } from "@/lib/session/sidebarDock";
import { useNavigation, type SidebarView } from "@/store/navigation";
import { useWorkspace } from "@/store/workspace";
import { PluginSidebarPanel } from "@/features/plugins/PluginSidebarPanel";
import { usePlugins } from "@/store/plugins";
import { pluginSidebars, parsePluginSidebar, type PluginSidebarView } from "@/lib/plugins/sidebars";

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

/** A retained owner outside SidebarContents may publish into the same movable slot. */
export function SidebarPortal({ view, children }: { view: SidebarView; children: ReactNode }) {
  return createPortal(
    <RetainedPanel view={view}>{children}</RetainedPanel>,
    containerFor(view),
    view,
  );
}

/** Move the existing DOM container; the list's React owner never changes. */
export function SidebarMount({
  view,
  docked = false,
  floating = false,
}: {
  view: SidebarView;
  docked?: boolean;
  floating?: boolean;
}) {
  const mount = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const target = mount.current;
    if (!target) return;
    const container = containerFor(view);
    if (container.parentElement !== target) target.append(container);
  }, [view, docked, floating]);
  return (
    <div
      className="sidebar-dock-mount"
      data-sidebar-slot={view}
      data-docked={docked || undefined}
      ref={mount}
    />
  );
}

function RetainedPanel({ view, children }: { view: SidebarView; children: ReactNode }) {
  const tabs = useWorkspace((state) => state.tabs);
  const panes = useWorkspace((state) => state.panes);
  const active = useNavigation((state) => state.activeSidebar);
  const sidebarVisible = useNavigation((state) => state.sidebarVisible);
  const presentation = panelPresentation(view)((state) => state);
  const floating = presentation.open;
  const tab = tabs.find((item) => item.id === sidebarTabId(view));
  const location = panelLocation(view);
  const visible = tab
    ? !tab.hidden && panes.some((pane) => pane.activeId === tab.id)
    : floating || (sidebarVisible && active === view);
  useLayoutEffect(() => {
    containerFor(view).hidden = !visible;
  }, [view, visible]);
  return (
    <WorkbenchPanel view={view} location={location} visible={visible}>
      {children}
    </WorkbenchPanel>
  );
}

export function FloatingPanelLayer() {
  const panels = usePanelPresentations((state) => state.panels);
  const tabs = useWorkspace((state) => state.tabs);
  const sidebarVisible = useNavigation((state) => state.sidebarVisible);
  const activeSidebar = useNavigation((state) => state.activeSidebar);
  useEffect(() => {
    for (const [id, state] of Object.entries(panels)) {
      if (!state?.open) continue;
      const view = id as SidebarView;
      const tab = tabs.find((item) => item.id === sidebarTabId(view));
      if (tab) {
        useWorkspace.getState().activate(tab.id);
        panelPresentation(view).getState().close();
      } else if (sidebarVisible && activeSidebar === view)
        panelPresentation(view).getState().close();
    }
  }, [panels, tabs, sidebarVisible, activeSidebar]);
  const entries = Object.entries(panels)
    .filter(
      ([view, state]) =>
        state?.open && !tabs.some((tab) => tab.id === sidebarTabId(view as SidebarView)),
    )
    .sort((a, b) => a[1]!.order - b[1]!.order);
  return (
    <div className="workbench-floating-layer">
      {entries.map(([id], index) => {
        const view = id as SidebarView;
        return (
          <div
            key={view}
            className="workbench-floating-slot"
            style={{ zIndex: index + 1 }}
            onPointerDownCapture={() => panelPresentation(view).getState().raise()}
          >
            <SidebarMount view={view} floating />
          </div>
        );
      })}
    </div>
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
  const panels = usePanelPresentations((state) => state.panels);
  const visible = useNavigation((state) => state.sidebarVisible);
  const active = useNavigation((state) => state.activeSidebar);
  const tabs = useWorkspace((state) => state.tabs);
  return visited
    .filter((view) => !panels[view]?.open && !tabs.some((tab) => tab.id === sidebarTabId(view)))
    .map((view) => <SidebarSlot key={view} view={view} hidden={!visible || active !== view} />);
}

export function SidebarContents() {
  const plugins = usePlugins((state) => state.items);
  const contributed = useMemo(
    () => new Set(pluginSidebars(plugins).map((item) => item.view)),
    [plugins],
  );
  const previous = useRef(contributed);
  useEffect(() => {
    for (const view of previous.current) {
      if (contributed.has(view)) continue;
      useWorkspace.getState().forgetSidebar(view);
      useNavigation.setState((state) => ({
        visitedSidebars: state.visitedSidebars.filter((item) => item !== view),
        ...(state.activeSidebar === view
          ? { activeSidebar: "hosts" as const, sidebarVisible: false }
          : {}),
      }));
    }
    previous.current = contributed;
  }, [contributed]);
  const presentations = usePanelPresentations((state) => state.panels);
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
  const views = useMemo(
    () =>
      [
        ...new Set([
          ...visited,
          ...docked,
          ...Object.entries(presentations)
            .filter(([, state]) => state?.open)
            .map(([id]) => id as SidebarView),
        ]),
      ].filter((view) => !parsePluginSidebar(view) || contributed.has(view as PluginSidebarView)),
    [visited, docked, presentations, contributed],
  );
  useEffect(() => {
    for (const view of views) useNavigation.getState().rememberSidebar(view);
  }, [views]);
  return views
    .filter((view) => view !== "filePreview")
    .map((view) => {
      const owner = panes.find((pane) => pane.tabIds.includes(sidebarTabId(view)));
      const active = owner
        ? owner.activeId === sidebarTabId(view) &&
          !tabs.find((tab) => tab.id === sidebarTabId(view))?.hidden
        : !!presentations[view]?.open || (sidebarVisible && activeSidebar === view);
      return createPortal(
        <RetainedPanel view={view}>
          {view === "hosts" ? (
            <ProviderSurface target="hostList" visible={active} keepFallback>
              <HostTree />
            </ProviderSurface>
          ) : view === "forwarding" ? (
            <ForwardingPanel />
          ) : view === "connections" ? (
            <ConnectionDetails />
          ) : view === "tasks" ? (
            <DockedBackgroundTasks />
          ) : view === "output" ? (
            <OutputPanel active={active} docked={!!owner} />
          ) : view === "plugins" ? (
            <PluginsSidebar />
          ) : parsePluginSidebar(view) ? (
            <PluginSidebarPanel view={view as PluginSidebarView} visible={active} />
          ) : (
            <TrustedHostsSidebar active={active} />
          )}
        </RetainedPanel>,
        containerFor(view),
        view,
      );
    });
}
