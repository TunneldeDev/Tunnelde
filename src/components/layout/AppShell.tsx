// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { useEffect, useRef, useState, type CSSProperties } from "react";

import { HostTree } from "@/components/layout/HostTree";
import { TrustedHostsSidebar } from "@/features/settings/TrustedHostsSidebar";
import { PluginsSidebar } from "@/features/plugins/PluginsSidebar";
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
import { useDialogs } from "@/store/dialogs";
import { useSettings } from "@/store/settings";
import { cn } from "@/lib/text/format";
import { DEFAULT_SETTINGS, MONO_FONT_SIZE_MAX, MONO_FONT_SIZE_MIN } from "@/lib/prefs/defaults";
import { closeTab } from "@/lib/session/tabActions";
import { useInternalDrag } from "@/lib/session/useInternalDrag";
import { useWindowCloseGuard } from "@/lib/session/useWindowCloseGuard";
import { useSsh } from "@/store/ssh";
import { isTauri } from "@/lib/api/ipc";
import { useWorkspace, type PanePosition, type SplitDirection } from "@/store/workspace";

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
  const openPage = useWorkspace((state) => state.openPage);
  const tabs = useWorkspace((state) => state.tabs);
  const sidebarVisible = useNavigation((state) => state.sidebarVisible);
  const activeSidebar = useNavigation((state) => state.activeSidebar);
  const visitedSidebars = useNavigation((state) => state.visitedSidebars);
  const activeId = useWorkspace((state) => state.activeId);
  const sessions = useSsh((state) => state.sessions);
  const openHostDialog = useDialogs((state) => state.openHost);

  const [sidebarDraft, setSidebarDraft] = useState<number | null>(null);
  const [panelDraft, setPanelDraft] = useState<number | null>(null);
  const [tabDrag, setTabDrag] = useState(false);
  const [edge, setEdge] = useState<string | null>(null);
  const [palette, setPalette] = useState(false);
  const workspace = useRef<HTMLElement>(null);
  const sidebarWidth = sidebarDraft ?? settings.sidebarWidth;
  const panelWidth = panelDraft ?? settings.rightPanelWidth;

  useEffect(() => {
    const element = workspace.current;
    if (!element) return;
    const rootEdge = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes(TAB_MIME)) return null;
      if (event.target instanceof Element && event.target.closest(".pane__tabs")) return null;
      const rect = element.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      const tabsHeight = element.querySelector(".pane__tabs")?.getBoundingClientRect().height ?? 34;
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
      const mod = event.ctrlKey || event.metaKey;
      if (!mod) {
        return;
      }
      // AltGr and terminal escape chords belong to the focused application.
      if (event.altKey || (event.ctrlKey && event.metaKey)) return;
      const key = event.key.toLowerCase();
      const terminalControl =
        event.ctrlKey &&
        !event.metaKey &&
        event.target instanceof Element &&
        !!event.target.closest(".terminal-host");
      if (terminalControl) {
        const workspaceShortcut =
          (event.shiftKey && ["p", "n", "w"].includes(key)) ||
          key === "tab" ||
          ["=", "+", "-", "0"].includes(key);
        // Preserve shell editing (Ctrl+K/N/W), tmux (Ctrl+B), SIGQUIT
        // (Ctrl+\\) and remote application chords. Explicit workspace commands
        // use Ctrl+Shift, while tab switching and font sizing stay available.
        if (!workspaceShortcut) return;
      }
      if (key === "b" && !event.shiftKey && !event.altKey) {
        event.preventDefault();
        useNavigation.getState().toggleSidebar();
        return;
      }
      if (key === "k" || (event.shiftKey && key === "p")) {
        event.preventDefault();
        setPalette(true);
        return;
      }
      if (key === "n") {
        event.preventDefault();
        openHostDialog();
        return;
      }
      if (key === ",") {
        event.preventDefault();
        openPage("settings");
        return;
      }
      if (key === "=" || key === "+" || key === "-" || key === "0") {
        const settings = useSettings.getState();
        const delta = key === "-" ? -1 : 1;
        const next =
          key === "0"
            ? (settings.info?.defaultSettings?.monoFontSize ?? DEFAULT_SETTINGS.monoFontSize)
            : Math.min(
                MONO_FONT_SIZE_MAX,
                Math.max(MONO_FONT_SIZE_MIN, settings.settings.monoFontSize + delta),
              );
        // A reserved shortcut remains consumed even at the default or limit;
        // otherwise Ctrl+0 can unexpectedly send NUL to the remote terminal.
        event.preventDefault();
        if (next !== settings.settings.monoFontSize) {
          void settings.update({ monoFontSize: next });
        }
        return;
      }

      const workspace = useWorkspace.getState();
      if (key === "w") {
        if (event.shiftKey && workspace.panes.length > 1) {
          event.preventDefault();
          workspace.closePane(workspace.activePaneId);
          return;
        }
        const tab = workspace.tabs.find((item) => item.id === workspace.activeId);
        if (tab) {
          event.preventDefault();
          closeTab(tab);
        }
        return;
      }
      if (key === "\\" || key === "|") {
        if (workspace.activeId) {
          event.preventDefault();
          workspace.splitTab(workspace.activeId, key === "|" ? "column" : "row");
        }
        return;
      }
      if (key === "tab") {
        event.preventDefault();
        const activePane = workspace.panes.find((pane) => pane.id === workspace.activePaneId);
        const tabs = (activePane?.tabIds ?? [])
          .map((id) => workspace.tabs.find((tab) => tab.id === id))
          .filter((tab) => !!tab);
        const { activeId } = workspace;
        if (tabs.length < 2) {
          return;
        }
        const index = tabs.findIndex((tab) => tab.id === activeId);
        const next = (index + (event.shiftKey ? -1 : 1) + tabs.length) % tabs.length;
        const target = tabs[next];
        if (target) {
          workspace.activate(target.id);
        }
        return;
      }
      if (/^[1-9]$/.test(key)) {
        const pane = workspace.panes.find((item) => item.id === workspace.activePaneId);
        const target = workspace.tabs.find((tab) => tab.id === pane?.tabIds[Number(key) - 1]);
        if (target) {
          event.preventDefault();
          workspace.activate(target.id);
        }
      }
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
  }, [openHostDialog, openPage, palette]);

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
        {visitedSidebars.map((view) => (
          <div
            className="sidebar-view"
            id={`sidebar-${view}`}
            key={view}
            hidden={!sidebarVisible || view !== activeSidebar}
          >
            {view === "hosts" ? <HostTree /> : null}
            {view === "knownHosts" ? (
              <TrustedHostsSidebar active={sidebarVisible && view === activeSidebar} />
            ) : null}
            {view === "plugins" ? <PluginsSidebar /> : null}
          </div>
        ))}
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
      <CommandPalette open={palette} onClose={() => setPalette(false)} />
    </div>
  );
}
