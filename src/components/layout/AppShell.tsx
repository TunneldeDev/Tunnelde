// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { useEffect, useState, type CSSProperties } from "react";

import { HostTree } from "@/components/layout/HostTree";
import { RemotePanel } from "@/components/layout/RemotePanel";
import { Resizer } from "@/components/layout/Resizer";
import { StatusBar } from "@/components/layout/StatusBar";
import { SystemPanel } from "@/components/layout/SystemPanel";
import { TabContent } from "@/components/layout/TabContent";
import { TopBar } from "@/components/layout/TopBar";
import { ToastHost } from "@/components/ui/Toast";
import { DialogHost } from "@/features/dialogs/DialogHost";
import { useDialogs } from "@/store/dialogs";
import { useSettings } from "@/store/settings";
import { useSsh } from "@/store/ssh";
import { useWorkspace } from "@/store/workspace";

export function AppShell() {
  const settings = useSettings((state) => state.settings);
  const updateSettings = useSettings((state) => state.update);
  const openPage = useWorkspace((state) => state.openPage);
  const tabs = useWorkspace((state) => state.tabs);
  const activeId = useWorkspace((state) => state.activeId);
  const sessions = useSsh((state) => state.sessions);
  const openHostDialog = useDialogs((state) => state.openHost);

  const [sidebarDraft, setSidebarDraft] = useState<number | null>(null);
  const [panelDraft, setPanelDraft] = useState<number | null>(null);
  const sidebarWidth = sidebarDraft ?? settings.sidebarWidth;
  const panelWidth = panelDraft ?? settings.rightPanelWidth;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey;
      if (!mod) {
        return;
      }
      const key = event.key.toLowerCase();
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

      const workspace = useWorkspace.getState();
      if (key === "w") {
        if (workspace.activeId) {
          event.preventDefault();
          workspace.close(workspace.activeId);
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
  const activeSession =
    activeTab && (activeTab.kind === "terminal" || activeTab.kind === "sftp")
      ? (sessions.find((session) => activeTab.id.endsWith(session.id)) ?? null)
      : activeTab?.kind === "host" && activeTab.hostId
        ? (sessions.find((session) => session.hostId === activeTab.hostId) ?? null)
        : null;

  const style = {
    "--td-sidebar-w": `${sidebarWidth}px`,
    "--td-panel-w": `${panelWidth}px`,
  } as CSSProperties;

  return (
    <div className="app" style={style}>
      <TopBar />
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
            void updateSettings({ sidebarWidth: value });
          }}
        />
        <main className="workspace">
          <TabContent />
        </main>
        {settings.rightPanel ? (
          <>
            <Resizer
              value={panelWidth}
              min={240}
              max={460}
              edge="left"
              label="Panel width"
              onChange={setPanelDraft}
              onCommit={(value) => {
                setPanelDraft(null);
                void updateSettings({ rightPanelWidth: value });
              }}
            />
            {activeSession ? (
              <RemotePanel
                sessionId={activeSession.id}
                width={panelWidth}
                onHide={() => void updateSettings({ rightPanel: false })}
              />
            ) : (
              <SystemPanel
                width={panelWidth}
                onHide={() => void updateSettings({ rightPanel: false })}
              />
            )}
          </>
        ) : null}
      </div>
      <StatusBar
        panelOpen={settings.rightPanel}
        onTogglePanel={() => void updateSettings({ rightPanel: !settings.rightPanel })}
      />
      <ToastHost />
      <DialogHost />
    </div>
  );
}
