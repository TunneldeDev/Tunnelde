import { reportError } from "@/lib/diagnostics";
import { MainSettingsWindowOwner } from "@/features/settings/window/NativeSettingsPage";
import { PluginPanelDialogs } from "@/features/plugins/panel/PluginPanelDialogs";
import { HostPanelDialogs } from "@/features/hosts/panel/HostPanelDialogs";
import { SplitGeometryScope } from "@/components/ui/layout/SplitGeometry";
import { subscribePanels } from "@/lib/panels/observation";
import { ShortcutConflictDialog } from "@/features/settings/ShortcutConflictDialog";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { createWorkbenchSurfaces } from "./WorkbenchSurfaces";
import { ProviderSurface } from "./ProviderSurface";

import { FloatingWorkspaceLayer } from "@/components/layout/PaneLayout";
import { SidebarArea, SidebarContents, FloatingPanelLayer } from "@/components/layout/SidebarDock";
import { CommandPalette } from "@/components/layout/CommandPalette";
import { FormatterPicker } from "@/features/editor/FormatterPicker";
import { isWorkspaceDrag, readWorkspaceDrop } from "@/lib/session/workspaceDrag";
import { PaneLayout } from "@/components/layout/PaneLayout";
import { WorkspaceContents } from "@/components/layout/TabContent";
import { ActivityBar } from "@/components/layout/ActivityBar";
import { WindowTitleBar } from "@/components/layout/WindowTitleBar";
import { useNavigation } from "@/store/navigation";
import { ContextMenuHost } from "@/components/ui/overlay/ContextMenu";
import { Resizer } from "@/components/layout/Resizer";
import { StatusBar } from "@/components/layout/StatusBar";

import { ToastHost } from "@/components/ui/overlay/Toast";
import { DialogHost } from "@/features/dialogs/DialogHost";
import { useSettings } from "@/store/settings";
import { cn } from "@/lib/text/format";
import { dispatchShortcuts } from "@/lib/keyboard/routing";
import { useInternalDrag } from "@/lib/session/useInternalDrag";
import { useWindowCloseGuard } from "@/lib/session/useWindowCloseGuard";
import { useNativeApplicationActions } from "@/lib/session/useNativeApplicationActions";
import { isTauri } from "@/lib/api/ipc";
import { useWorkspace, type PanePosition, type SplitDirection } from "@/store/workspace";
import { sidebarTabId } from "@/lib/session/sidebarDock";
import { useQuickAccess } from "@/store/quickAccess";
import { RestartPrompt } from "@/components/layout/RestartPrompt";
import { FilePreview } from "@/features/sftp/FilePreview";
import { BackgroundTaskStatusButton } from "@/features/tasks/BackgroundTasks";
import { useBackgroundWindow } from "@/app/backgroundWindow";
import { wireTabBarContributions } from "@/store/tabBar";
import { wireHostDecorations } from "@/store/hostDecorations";
import { wireFileHighlights } from "@/store/fileHighlights";
import { wireHostColumns } from "@/store/hostColumns";
import { wireHostSources } from "@/store/hostSources";

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
    const stopPanels = subscribePanels(() => {
      void import("@tauri-apps/api/event")
        .then(({ emit }) => emit("workspace://panels-changed", { windowId: "main" }))
        .catch(() => {});
    });
    void wireHostSources(controller.signal).catch((error: unknown) =>
      reportError("plugins.hostSources", "subscribe", error),
    );
    void wireHostColumns(controller.signal).catch((error: unknown) =>
      reportError("plugins.hostColumns", "subscribe", error),
    );
    void wireTabBarContributions(controller.signal).catch((error: unknown) =>
      reportError("plugins.tabBar", "subscribe", error),
    );
    void wireHostDecorations(controller.signal).catch((error: unknown) =>
      reportError("plugins.hostDecorations", "subscribe", error),
    );
    void wireFileHighlights(controller.signal).catch((error: unknown) =>
      reportError("plugins.fileHighlights", "subscribe", error),
    );
    return () => {
      stopPanels();
      controller.abort();
    };
  }, []);
  useInternalDrag();
  useWindowCloseGuard();
  useNativeApplicationActions();
  useBackgroundWindow();
  const settings = useSettings((state) => state.settings);
  const os = useSettings((state) => state.info?.os);
  const updateSettings = useSettings((state) => state.update);
  const tabs = useWorkspace((state) => state.tabs);
  const sidebarRequested = useNavigation((state) => state.sidebarVisible);
  const activeSidebar = useNavigation((state) => state.activeSidebar);
  const sidebarVisible =
    sidebarRequested && !tabs.some((tab) => tab.id === sidebarTabId(activeSidebar));

  const [tabDrag, setTabDrag] = useState(false);
  const [edge, setEdge] = useState<string | null>(null);
  const palette = useQuickAccess((state) => state.query !== null);
  const workspace = useRef<HTMLElement>(null);
  const app = useRef<HTMLDivElement>(null);
  const sidebarWidth = settings.sidebarWidth;

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

  const style = {
    "--td-sidebar-w": `${sidebarWidth}px`,
  } as CSSProperties;

  return (
    <SplitGeometryScope>
      <div
        ref={app}
        className={cn(
          "app",
          isTauri() && settings.titleBarStyle === "compact" && "is-compact-chrome",
          os === "macos" && "is-macos",
          sidebarVisible && "has-sidebar",
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
        <MainSettingsWindowOwner />
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
                    className={cn(
                      "pane-edge",
                      `is-${item.edge}`,
                      edge === item.edge && "is-active",
                    )}
                  />
                ))}
              </div>
            ) : null}
          </main>,
          surfaces.container("workspace"),
        )}
        {createPortal(
          settings.showStatusBar ? <StatusBar /> : null,
          surfaces.container("statusbar"),
        )}
        <ToastHost />
        <HostPanelDialogs />
        <PluginPanelDialogs />
        <DialogHost />
        <ShortcutConflictDialog />
        <ContextMenuHost />
        <CommandPalette />
        <RestartPrompt />
        <FormatterPicker />
        <FilePreview />
        <FloatingPanelLayer>
          <FloatingWorkspaceLayer />
        </FloatingPanelLayer>
        {!settings.showStatusBar ? <BackgroundTaskStatusButton floating /> : null}
      </div>
    </SplitGeometryScope>
  );
}
