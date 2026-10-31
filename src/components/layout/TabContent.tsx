// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { useEffect, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import { EmptyState } from "@/components/ui/display/Misc";
import { AboutPage } from "@/features/about/AboutPage";
import { EditorPage } from "@/features/editor/EditorPage";
import { HistoryPage } from "@/features/history/HistoryPage";
import { MonitorPage } from "@/features/monitor/MonitorPage";
import { PluginViewPage } from "@/features/plugins/PluginViewPage";
import { HostPage } from "@/features/hosts/HostPage";
import { SftpPage } from "@/features/sftp/SftpPage";
import { SettingsPage } from "@/features/settings/SettingsPage";
import { KnownHostsPage } from "@/features/settings/KnownHostsPage";
import { TerminalPage } from "@/features/terminal/TerminalPage";
import { UpdatesPage } from "@/features/updates/UpdatesPage";
import { WelcomePage } from "@/features/welcome/WelcomePage";
import { useWorkspace, type WorkspaceTab } from "@/store/workspace";

function TabBody({
  tab,
  active,
  visible,
}: {
  tab: WorkspaceTab;
  active: boolean;
  visible: boolean;
}) {
  switch (tab.kind) {
    case "welcome":
      return <WelcomePage />;
    case "host":
      return <HostPage hostId={tab.hostId} />;
    case "settings":
      return <SettingsPage />;
    case "knownHosts":
      return <KnownHostsPage />;
    case "about":
      return <AboutPage />;
    case "updates":
      return <UpdatesPage />;
    case "terminal":
      return <TerminalPage sessionId={tab.id.replace("terminal:", "")} active={active} />;
    case "sftp":
      return <SftpPage sessionId={tab.id.replace("sftp:", "")} />;
    case "editor":
      return <EditorPage tabId={tab.id} active={active} />;
    case "history":
      return <HistoryPage sessionId={tab.id.replace("history:", "")} />;
    case "monitor":
      return <MonitorPage sessionId={tab.id.replace("monitor:", "")} active={visible} />;
    case "pluginView": {
      const rest = tab.id.replace("plugin:", "");
      const separator = rest.indexOf(":");
      const pluginId = separator >= 0 ? rest.slice(0, separator) : rest;
      const viewId = separator >= 0 ? rest.slice(separator + 1) : "default";
      return <PluginViewPage pluginId={pluginId} viewId={viewId} />;
    }
    default:
      return null;
  }
}

export function TabContent({ paneId }: { paneId?: string }) {
  const { t } = useTranslation();
  const tabs = useWorkspace((state) => state.tabs);
  const panes = useWorkspace((state) => state.panes);
  const activePaneId = useWorkspace((state) => state.activePaneId);
  const pane = panes.find((item) => item.id === (paneId ?? activePaneId));
  const mount = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const target = mount.current;
    if (!target || !pane) return;
    for (const id of pane.tabIds) {
      const container = tabContainer(id);
      if (container.parentElement !== target) target.appendChild(container);
      container.hidden = id !== pane.activeId;
    }
  }, [pane, tabs]);

  useEffect(() => {
    const target = mount.current;
    if (!target || !pane) return;
    // Portal events follow their React owner. Listen on the actual DOM mount so
    // clicking or tabbing into a page still focuses the group containing it.
    const focus = () => {
      if (useWorkspace.getState().activePaneId !== pane.id)
        useWorkspace.getState().activatePane(pane.id);
    };
    target.addEventListener("mousedown", focus);
    target.addEventListener("focusin", focus);
    return () => {
      target.removeEventListener("mousedown", focus);
      target.removeEventListener("focusin", focus);
    };
  }, [pane]);

  if (!pane || pane.tabIds.length === 0) {
    return (
      <div className="page">
        <EmptyState title={t("host.emptyTitle")} body={t("host.emptyBody")} />
      </div>
    );
  }

  return (
    <div
      ref={mount}
      className="pane-content"
      style={{ display: "flex", flex: "1 1 0", minWidth: 0, minHeight: 0 }}
    />
  );
}

const tabContainers = new Map<string, HTMLDivElement>();

function tabContainer(id: string): HTMLDivElement {
  let container = tabContainers.get(id);
  if (!container) {
    container = document.createElement("div");
    container.className = "tab-panel";
    container.dataset.contentTabId = id;
    container.hidden = true;
    tabContainers.set(id, container);
  }
  return container;
}

/** Own each page once; moving its DOM between groups keeps live terminals and file views intact. */
export function WorkspaceContents() {
  const tabs = useWorkspace((state) => state.tabs);
  const panes = useWorkspace((state) => state.panes);
  const activePaneId = useWorkspace((state) => state.activePaneId);

  useEffect(() => {
    const ids = new Set(tabs.map((tab) => tab.id));
    for (const [id, container] of tabContainers) {
      if (ids.has(id)) continue;
      container.remove();
      tabContainers.delete(id);
    }
  }, [tabs]);

  return tabs.map((tab) => {
    const owner = panes.find((pane) => pane.tabIds.includes(tab.id));
    const visible = owner?.activeId === tab.id;
    return createPortal(
      <TabBody tab={tab} visible={visible} active={visible && owner?.id === activePaneId} />,
      tabContainer(tab.id),
      tab.id,
    );
  });
}
