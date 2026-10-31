// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)
import { Blocks, Home, Server, Settings, ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { IconButton } from "@/components/ui/form/Button";
import { useNavigation } from "@/store/navigation";
import { useWorkspace } from "@/store/workspace";

export function ActivityBar() {
  const { t } = useTranslation();
  const visible = useNavigation((state) => state.sidebarVisible);
  const toggle = useNavigation((state) => state.toggleSidebar);
  const select = useNavigation((state) => state.selectSettings);
  const openPage = useWorkspace((state) => state.openPage);
  const kind = useWorkspace((state) => state.tabs.find((tab) => tab.id === state.activeId)?.kind);
  return (
    <nav className="activitybar" aria-label={t("nav.workspace")}>
      <IconButton label={t("sidebar.hosts")} active={visible} onClick={toggle}>
        <Server size={21} />
      </IconButton>
      <IconButton
        label={t("nav.welcome")}
        active={kind === "welcome"}
        onClick={() => openPage("welcome")}
      >
        <Home size={21} />
      </IconButton>
      <IconButton
        label={t("settings.knownHosts")}
        active={kind === "knownHosts"}
        onClick={() => openPage("knownHosts")}
      >
        <ShieldCheck size={21} />
      </IconButton>
      <IconButton
        label={t("settings.plugins")}
        onClick={() => {
          select("plugins");
          openPage("settings");
        }}
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
