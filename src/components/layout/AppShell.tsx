import { useEffect, useRef, useState, type CSSProperties } from "react";

import { SidebarArea, SidebarContents } from "@/components/layout/SidebarDock";
import { CommandPalette } from "@/components/layout/CommandPalette";
import { TAB_MIME } from "@/components/layout/PaneView";
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
import { runWorkbenchCommand } from "@/lib/keyboard/actions";
import {
  shortcutCommands,
  isTextTarget,
  matchesCommand,
  terminalAllowsCommand,
} from "@/lib/keyboard/registry";
import { useInternalDrag } from "@/lib/session/useInternalDrag";
import { useWindowCloseGuard } from "@/lib/session/useWindowCloseGuard";
import { useSsh } from "@/store/ssh";
import { isTauri } from "@/lib/api/ipc";
import { useWorkspace, type PanePosition, type SplitDirection } from "@/store/workspace";
import { sidebarTabId } from "@/lib/session/sidebarDock";
import { usePlugins } from "@/store/plugins";
import { useQuickAccess } from "@/store/quickAccess";
import { FilePreview } from "@/features/sftp/FilePreview";

const EDGES: Array<{ edge: string; direction: SplitDirection; position: PanePosition }> = [
  { edge: "left", direction: "row", position: "before" },
  { edge: "right", direction: "row", position: "after" },
  { edge: "top", direction: "column", position: "before" },
  { edge: "bottom", direction: "column", position: "after" },
];

export function AppShell() {
  useInternalDrag();
  useWindowCloseGuard();
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

  const [sidebarDraft, setSidebarDraft] = useState<number | null>(null);
  const [panelDraft, setPanelDraft] = useState<number | null>(null);
  const [tabDrag, setTabDrag] = useState(false);
  const [edge, setEdge] = useState<string | null>(null);
  const palette = useQuickAccess((state) => state.query !== null);
  const workspace = useRef<HTMLElement>(null);
  const sidebarWidth = sidebarDraft ?? settings.sidebarWidth;
  const panelWidth = panelDraft ?? settings.rightPanelWidth;

  useEffect(() => {
    const element = workspace.current;
    if (!element) return;
    const rootEdge = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes(TAB_MIME)) return null;
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
      const tabId = event.dataTransfer?.getData(TAB_MIME);
      setEdge(null);
      if (!target || !tabId) return;
      event.preventDefault();
      event.stopPropagation();
      useWorkspace.getState().splitTab(tabId, target.direction, target.position, "root");
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
      if (event.dataTransfer?.types.includes(TAB_MIME)) {
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
      if (
        event.defaultPrevented ||
        event.isComposing ||
        palette ||
        document.querySelector("[role='dialog'], .td-select__popup, [role='menu']")
      )
        return;
      const overrides = useSettings.getState().settings.keyboardShortcuts ?? {};
      const terminal = event.target instanceof Element && !!event.target.closest(".terminal-host");
      const definitions = shortcutCommands(usePlugins.getState().items);
      const command = definitions.find(
        (item) =>
          item.scope === "workbench" &&
          (!isTextTarget(event.target) || terminal || item.input) &&
          (!terminal || terminalAllowsCommand(event, item.id, overrides)) &&
          matchesCommand(event, item.id, overrides, definitions),
      );
      if (command && runWorkbenchCommand(command.id)) event.preventDefault();
    };

    const onTerminalKeyDown = (event: KeyboardEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest(".terminal-host")) return;
      // xterm handles keys at its target. Route only actual workspace commands
      // before they reach it, so one shortcut cannot also send SSH input.
      if (event.defaultPrevented) return;
      onKeyDown(event);
      if (event.defaultPrevented) event.stopPropagation();
    };
    window.addEventListener("keydown", onTerminalKeyDown, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onTerminalKeyDown, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [palette]);

  const activeTab = tabs.find((tab) => tab.id === activeId) ?? null;
  const activeSession = (() => {
    if (!activeTab) {
      return null;
    }
    if (activeTab.kind === "terminal" || activeTab.kind === "sftp") {
      return sessions.find((session) => activeTab.id.endsWith(session.id)) ?? null;
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
      <div className="app__body">
        <ActivityBar />
        <SidebarArea />
        <SidebarContents />
        {sidebarVisible ? (
          <Resizer
            value={sidebarWidth}
            min={220}
            max={420}
            edge="right"
            label="Sidebar width"
            onChange={setSidebarDraft}
            onCommit={(value) => {
              setSidebarDraft(null);
              void updateSettings({ sidebarWidth: Math.round(value) });
            }}
          />
        ) : null}
        <main className="workspace" ref={workspace}>
          <PaneLayout />
          <WorkspaceContents />
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
        </main>
        {settings.rightPanel ? (
          <Resizer
            value={panelWidth}
            min={240}
            max={460}
            edge="left"
            label="Panel width"
            onChange={setPanelDraft}
            onCommit={(value) => {
              setPanelDraft(null);
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
      </div>
      {settings.showStatusBar ? (
        <StatusBar
          panelOpen={settings.rightPanel}
          onTogglePanel={() => void updateSettings({ rightPanel: !settings.rightPanel })}
        />
      ) : null}
      <ToastHost />
      <DialogHost />
      <ContextMenuHost />
      <CommandPalette />
      <FilePreview />
    </div>
  );
}
