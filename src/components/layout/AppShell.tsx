// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { useEffect, useRef, useState, type CSSProperties } from "react";

import { HostTree } from "@/components/layout/HostTree";
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
      const key = event.key.toLowerCase();
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
          key === "0" ? 13 : Math.min(20, Math.max(11, settings.settings.monoFontSize + delta));
        if (next !== settings.settings.monoFontSize) {
          event.preventDefault();
          void settings.update({ monoFontSize: next });
        }
        return;
      }

      const workspace = useWorkspace.getState();
      if (key === "w") {
        if (
          !event.metaKey &&
          !event.shiftKey &&
          event.target instanceof Element &&
          event.target.closest(".terminal-host")
        )
          return;
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

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
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
      )}
      style={style}
    >
      <WindowTitleBar />
      <div className="app__body">
        <ActivityBar />
        {sidebarVisible ? <HostTree /> : null}
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
      <StatusBar
        panelOpen={settings.rightPanel}
        onTogglePanel={() => void updateSettings({ rightPanel: !settings.rightPanel })}
      />
      <ToastHost />
      <DialogHost />
      <ContextMenuHost />
      <CommandPalette open={palette} onClose={() => setPalette(false)} />
    </div>
  );
}
