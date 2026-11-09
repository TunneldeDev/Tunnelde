import { ShortcutConflictDialog } from "@/features/settings/ShortcutConflictDialog";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { createWorkbenchSurfaces } from "./WorkbenchSurfaces";
import { ProviderSurface } from "./ProviderSurface";

import { SidebarArea, SidebarContents } from "@/components/layout/SidebarDock";
import { CommandPalette } from "@/components/layout/CommandPalette";
import { FormatterPicker } from "@/features/editor/FormatterPicker";
import { isWorkspaceDrag, readWorkspaceDrop } from "@/lib/session/workspaceDrag";
import { PaneLayout } from "@/components/layout/PaneLayout";
import { WorkspaceContents } from "@/components/layout/TabContent";
import { ActivityBar } from "@/components/layout/ActivityBar";
import { WindowTitleBar } from "@/components/layout/WindowTitleBar";
import { useNavigation } from "@/store/navigation";
import { useEditors } from "@/store/editors";
import { RemotePanel } from "@/components/layout/RemotePanel";
import { ContextMenuHost } from "@/components/ui/overlay/ContextMenu";
import { Resizer } from "@/components/layout/Resizer";
import { StatusBar } from "@/components/layout/StatusBar";
import { SystemPanel } from "@/components/layout/SystemPanel";

import { ToastHost } from "@/components/ui/overlay/Toast";
import { DialogHost } from "@/features/dialogs/DialogHost";
import { useSettings } from "@/store/settings";
import { cn } from "@/lib/text/format";
import { dispatchShortcuts } from "@/lib/keyboard/routing";
import { useInternalDrag } from "@/lib/session/useInternalDrag";
import { useWindowCloseGuard } from "@/lib/session/useWindowCloseGuard";
import { useSsh } from "@/store/ssh";
import { isTauri } from "@/lib/api/ipc";
import { useWorkspace, type PanePosition, type SplitDirection } from "@/store/workspace";
import { sidebarTabId } from "@/lib/session/sidebarDock";
import { useQuickAccess } from "@/store/quickAccess";
import { RestartPrompt } from "@/components/layout/RestartPrompt";
import { FilePreview } from "@/features/sftp/FilePreview";
import { BackgroundTasks, BackgroundTaskStatusButton } from "@/features/tasks/BackgroundTasks";
import { useBackgroundWindow } from "@/app/backgroundWindow";
import { wireTabBarContributions } from "@/store/tabBar";
import { wireHostDecorations } from "@/store/hostDecorations";
import { wireHostColumns } from "@/store/hostColumns";

const EDGES: Array<{ edge: string; direction: SplitDirection; position: PanePosition }> = [
  { edge: "left", direction: "row", position: "before" },
  { edge: "right", direction: "row", position: "after" },
  { edge: "top", direction: "column", position: "before" },
  { edge: "bottom", direction: "column", position: "after" },
];

export function AppShell() {
  const [surfaces] = useState(createWorkbenchSurfaces);
  useEffect(() => {
    if (!isTauri()) return;
    const controller = new AbortController();
    void wireHostColumns(controller.signal).catch((error: unknown) =>
      console.error("Host columns subscription failed", error),
    );
    void wireTabBarContributions(controller.signal).catch((error: unknown) =>
      console.error("Tab bar subscription failed", error),
    );
    void wireHostDecorations(controller.signal).catch((error: unknown) =>
      console.error("Host decorations subscription failed", error),
    );
    return () => controller.abort();
  }, []);
  useInternalDrag();
  useWindowCloseGuard();
  useBackgroundWindow();
  const settings = useSettings((state) => state.settings);
  const os = useSettings((state) => state.info?.os);
  const updateSettings = useSettings((state) => state.update);
  const tabs = useWorkspace((state) => state.tabs);
  const sidebarRequested = useNavigation((state) => state.sidebarVisible);
  const activeSidebar = useNavigation((state) => state.activeSidebar);
  const sidebarVisible =
    sidebarRequested && !tabs.some((tab) => tab.id === sidebarTabId(activeSidebar));
  const activeId = useWorkspace((state) => state.activeId);
  const sessions = useSsh((state) => state.sessions);

  const [tabDrag, setTabDrag] = useState(false);
  const [edge, setEdge] = useState<string | null>(null);
  const palette = useQuickAccess((state) => state.query !== null);
  const workspace = useRef<HTMLElement>(null);
  const app = useRef<HTMLDivElement>(null);
  const sidebarWidth = settings.sidebarWidth;
  const panelWidth = settings.rightPanelWidth;

  useEffect(() => {
    const element = workspace.current;
    if (!element) return;
    const rootEdge = (event: DragEvent) => {
      if (!isWorkspaceDrag(event.dataTransfer)) return null;
      if (event.target instanceof Element && event.target.closest(".pane__header")) return null;
      const rect = element.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const tabsHeight =
        element.querySelector(".pane__header")?.getBoundingClientRect().height ?? 34;
      const name =
        x < 32
          ? "left"
          : x > rect.width - 32
            ? "right"
            : y > rect.height - 32
              ? "bottom"
              : y < tabsHeight + 32
                ? "top"
                : null;
      return EDGES.find((item) => item.edge === name) ?? null;
    };
    const over = (event: DragEvent) => {
      const target = rootEdge(event);
      setEdge(target?.edge ?? null);
      if (!target || !event.dataTransfer) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "move";
    };
    const drop = (event: DragEvent) => {
      const target = rootEdge(event);
      setEdge(null);
      if (!target) return;
      const dropped = readWorkspaceDrop(event.dataTransfer);
      if (!dropped) return;
      event.preventDefault();
      event.stopPropagation();
      useWorkspace
        .getState()
        .splitTab(dropped.tabId, target.direction, target.position, "root", dropped.size);
      dropped.finish();
      setTabDrag(false);
    };
    element.addEventListener("dragover", over, true);
    element.addEventListener("drop", drop, true);
    return () => {
      element.removeEventListener("dragover", over, true);
      element.removeEventListener("drop", drop, true);
    };
  }, []);

  useEffect(() => {
    const onDragStart = (event: DragEvent) => {
      if (isWorkspaceDrag(event.dataTransfer)) {
        setTabDrag(true);
      }
    };
    const onDragEnd = () => {
      setTabDrag(false);
      setEdge(null);
    };
    document.addEventListener("dragstart", onDragStart);
    document.addEventListener("dragend", onDragEnd);
    document.addEventListener("drop", onDragEnd);
    return () => {
      document.removeEventListener("dragstart", onDragStart);
      document.removeEventListener("dragend", onDragEnd);
      document.removeEventListener("drop", onDragEnd);
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!palette) dispatchShortcuts(event);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [palette]);

  const activeTab = tabs.find((tab) => tab.id === activeId) ?? null;
  const activeSession = (() => {
    if (!activeTab) {
      return null;
    }
    if (["terminal", "monitor", "history"].includes(activeTab.kind)) {
      return sessions.find((session) => activeTab.id === `${activeTab.kind}:${session.id}`) ?? null;
    }
    if (activeTab.kind === "sftp") {
      const id =
        activeTab.fileSessionId !== undefined
          ? activeTab.fileSessionId
          : activeTab.filePane
            ? activeTab.filePane.source.kind === "remote" && !activeTab.filePane.offline
              ? activeTab.filePane.source.sessionId
              : null
            : activeTab.id.replace(/^sftp:/, "").split(":copy:")[0];
      return sessions.find((session) => session.id === id) ?? null;
    }
    if (activeTab.kind === "editor") {
      const editor = useEditors.getState().entries[activeTab.id];
      return sessions.find((session) => session.id === editor?.sessionId) ?? null;
    }
    if (activeTab.kind === "host" && activeTab.hostId) {
      return sessions.find((session) => session.hostId === activeTab.hostId) ?? null;
    }
    return null;
  })();

  const style = {
    "--td-sidebar-w": `${sidebarWidth}px`,
    "--td-panel-w": `${panelWidth}px`,
  } as CSSProperties;

  return (
    <div
      ref={app}
      className={cn(
        "app",
        isTauri() && settings.titleBarStyle === "compact" && "is-compact-chrome",
        os === "macos" && "is-macos",
        sidebarVisible && "has-sidebar",
        settings.rightPanel && "has-panel",
        !settings.showStatusBar && "is-statusbar-hidden",
      )}
      style={style}
    >
      <WindowTitleBar />
      <ProviderSurface
        target="workbench"
        slots={surfaces.slots}
        validate={surfaces.hasWorkspace}
        subscribe={surfaces.subscribe}
      >
        <div className="app__body">
          <surfaces.slots.Navigation />
          <surfaces.slots.Workspace />
          <surfaces.slots.Inspector />
        </div>
        <surfaces.slots.StatusBar />
      </ProviderSurface>
      <SidebarContents />
      <WorkspaceContents />
      {createPortal(
        <>
          <ActivityBar />
          <SidebarArea />
          {sidebarVisible ? (
            <Resizer
              value={sidebarWidth}
              min={220}
              max={420}
              edge="right"
              label="Sidebar width"
              onChange={(value) => app.current?.style.setProperty("--td-sidebar-w", `${value}px`)}
              onCommit={(value) => {
                void updateSettings({ sidebarWidth: Math.round(value) });
              }}
            />
          ) : null}
        </>,
        surfaces.container("navigation"),
      )}
      {createPortal(
        <main className="workspace" ref={workspace}>
          <PaneLayout />
          {tabDrag ? (
            <div className="pane-edges">
              {EDGES.map((item) => (
                <div
                  key={item.edge}
                  className={cn("pane-edge", `is-${item.edge}`, edge === item.edge && "is-active")}
                />
              ))}
            </div>
          ) : null}
        </main>,
        surfaces.container("workspace"),
      )}
      {createPortal(
        <>
          {settings.rightPanel ? (
            <Resizer
              value={panelWidth}
              min={240}
              max={460}
              edge="left"
              label="Panel width"
              onChange={(value) => app.current?.style.setProperty("--td-panel-w", `${value}px`)}
              onCommit={(value) => {
                void updateSettings({ rightPanelWidth: Math.round(value) });
              }}
            />
          ) : null}
          {activeSession ? (
            <RemotePanel
              sessionId={activeSession.id}
              width={panelWidth}
              hidden={!settings.rightPanel}
              onHide={() => void updateSettings({ rightPanel: false })}
            />
          ) : (
            <SystemPanel
              width={panelWidth}
              hidden={!settings.rightPanel}
              onHide={() => void updateSettings({ rightPanel: false })}
            />
          )}
        </>,
        surfaces.container("inspector"),
      )}
      {createPortal(
        settings.showStatusBar ? (
          <StatusBar
            panelOpen={settings.rightPanel}
            onTogglePanel={() => void updateSettings({ rightPanel: !settings.rightPanel })}
          />
        ) : null,
        surfaces.container("statusbar"),
      )}
      <ToastHost />
      <DialogHost />
      <ShortcutConflictDialog />
      <ContextMenuHost />
      <CommandPalette />
      <RestartPrompt />
      <FormatterPicker />
      <FilePreview />
      <BackgroundTasks />
      {!settings.showStatusBar ? <BackgroundTaskStatusButton floating /> : null}
    </div>
  );
}
