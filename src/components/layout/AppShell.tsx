// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { useEffect, useState, type CSSProperties } from "react";

import { HostTree } from "@/components/layout/HostTree";
import { CommandPalette } from "@/components/layout/CommandPalette";
import { PaneView, TAB_MIME } from "@/components/layout/PaneView";
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
import { useSsh } from "@/store/ssh";
import { useWorkspace, type PanePosition, type SplitDirection } from "@/store/workspace";

const EDGES: Array<{ edge: string; direction: SplitDirection; position: PanePosition }> = [
  { edge: "left", direction: "row", position: "before" },
  { edge: "right", direction: "row", position: "after" },
  { edge: "top", direction: "column", position: "before" },
  { edge: "bottom", direction: "column", position: "after" },
];

export function AppShell() {
  const settings = useSettings((state) => state.settings);
  const updateSettings = useSettings((state) => state.update);
  const openPage = useWorkspace((state) => state.openPage);
  const tabs = useWorkspace((state) => state.tabs);
  const panes = useWorkspace((state) => state.panes);
  const activePaneId = useWorkspace((state) => state.activePaneId);
  const split = useWorkspace((state) => state.split);
  const activeId = useWorkspace((state) => state.activeId);
  const sessions = useSsh((state) => state.sessions);
  const openHostDialog = useDialogs((state) => state.openHost);

  const [sidebarDraft, setSidebarDraft] = useState<number | null>(null);
  const [panelDraft, setPanelDraft] = useState<number | null>(null);
  const [tabDrag, setTabDrag] = useState(false);
  const [edge, setEdge] = useState<string | null>(null);
  const [palette, setPalette] = useState(false);
  const sidebarWidth = sidebarDraft ?? settings.sidebarWidth;
  const panelWidth = panelDraft ?? settings.rightPanelWidth;

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
          key === "0"
            ? 13
            : Math.min(20, Math.max(11, settings.settings.monoFontSize + delta));
        if (next !== settings.settings.monoFontSize) {
          event.preventDefault();
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
        const { tabs, activeId } = workspace;
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
        const target = workspace.tabs[Number(key) - 1];
        if (target) {
          event.preventDefault();
          workspace.activate(target.id);
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [openHostDialog, openPage]);

  const activeTab = tabs.find((tab) => tab.id === activeId) ?? null;
  const activeSession = (() => {
    if (!activeTab) {
      return null;
    }
    if (activeTab.kind === "terminal" || activeTab.kind === "sftp") {
      return sessions.find((session) => activeTab.id.endsWith(session.id)) ?? null;
    }
    if (activeTab.kind === "editor") {
      return sessions.find((session) => activeTab.id.startsWith(`editor:${session.id}:`)) ?? null;
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
    <div className="app" style={style}>
      <div className="app__body">
        <HostTree />
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
        <main className="workspace">
          <div className={cn("panes", split && `is-${split}`)}>
            {panes.map((item) => (
              <PaneView key={item.id} pane={item} active={item.id === activePaneId} />
            ))}
          </div>
          {tabDrag ? (
            <div className="pane-edges">
              {EDGES.map((item) => (
                <div
                  key={item.edge}
                  className={cn("pane-edge", `is-${item.edge}`, edge === item.edge && "is-active")}
                  onDragOver={(event) => {
                    if (!event.dataTransfer.types.includes(TAB_MIME)) {
                      return;
                    }
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                    setEdge(item.edge);
                  }}
                  onDragLeave={() => setEdge(null)}
                  onDrop={(event) => {
                    const tabId = event.dataTransfer.getData(TAB_MIME);
                    setEdge(null);
                    if (tabId) {
                      event.preventDefault();
                      useWorkspace.getState().splitTab(tabId, item.direction, item.position);
                    }
                  }}
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
