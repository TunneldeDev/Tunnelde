// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)
import { Blocks, Server, Settings, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { IconButton } from "@/components/ui/form/Button";
import { useNavigation } from "@/store/navigation";
import { useWorkspace } from "@/store/workspace";

export function ActivityBar() {
  const { t } = useTranslation();
  const visible = useNavigation((state) => state.sidebarVisible);
  const activeSidebar = useNavigation((state) => state.activeSidebar);
  const select = useNavigation((state) => state.selectSidebar);
  const openPage = useWorkspace((state) => state.openPage);
  const kind = useWorkspace((state) => state.tabs.find((tab) => tab.id === state.activeId)?.kind);
  return (
    <nav className="activitybar" aria-label={t("nav.workspace")}>
      <IconButton
        label={t("sidebar.hosts")}
        active={activeSidebar === "hosts"}
        aria-expanded={visible && activeSidebar === "hosts"}
        aria-controls="sidebar-hosts"
        onClick={() => select("hosts")}
      >
        <Server size={21} />
      </IconButton>
      <IconButton
        label={t("settings.knownHosts")}
        active={activeSidebar === "knownHosts"}
        aria-expanded={visible && activeSidebar === "knownHosts"}
        aria-controls="sidebar-knownHosts"
        onClick={() => select("knownHosts")}
      >
        <ShieldCheck size={21} />
      </IconButton>
      <IconButton
        label={t("settings.plugins")}
        active={activeSidebar === "plugins"}
        aria-expanded={visible && activeSidebar === "plugins"}
        aria-controls="sidebar-plugins"
        onClick={() => select("plugins")}
      >
        <Blocks size={21} />
      </IconButton>
      <span className="activitybar__spacer" />
      <IconButton
        label={t("nav.settings")}
        active={kind === "settings"}
        onClick={() => openPage("settings")}
      >
        <Settings size={21} />
      </IconButton>
    </nav>
  );
}
