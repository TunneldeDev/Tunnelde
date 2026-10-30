// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { useTranslation } from "react-i18next";

import { EmptyState } from "@/components/ui/Misc";
import { AboutPage } from "@/features/about/AboutPage";
import { HostPage } from "@/features/hosts/HostPage";
import { SettingsPage } from "@/features/settings/SettingsPage";
import { TerminalPage } from "@/features/terminal/TerminalPage";
import { UpdatesPage } from "@/features/updates/UpdatesPage";
import { WelcomePage } from "@/features/welcome/WelcomePage";
import { useWorkspace, type WorkspaceTab } from "@/store/workspace";

function TabBody({ tab, active }: { tab: WorkspaceTab; active: boolean }) {
  switch (tab.kind) {
    case "welcome":
      return <WelcomePage />;
    case "host":
      return <HostPage hostId={tab.hostId} />;
    case "settings":
      return <SettingsPage />;
    case "about":
      return <AboutPage />;
    case "updates":
      return <UpdatesPage />;
    case "terminal":
      return <TerminalPage sessionId={tab.id.replace("terminal:", "")} active={active} />;
    default:
      return null;
  }
}

export function TabContent() {
  const { t } = useTranslation();
  const tabs = useWorkspace((state) => state.tabs);
  const activeId = useWorkspace((state) => state.activeId);

  if (tabs.length === 0) {
    return (
      <div className="page">
        <EmptyState title={t("host.emptyTitle")} body={t("host.emptyBody")} />
      </div>
    );
  }

  return (
    <>
      {tabs.map((tab) => (
        <div key={tab.id} className="tab-panel" hidden={tab.id !== activeId}>
          <TabBody tab={tab} active={tab.id === activeId} />
        </div>
      ))}
    </>
  );
}
