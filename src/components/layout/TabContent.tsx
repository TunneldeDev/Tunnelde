// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { useTranslation } from "react-i18next";

import { EmptyState } from "@/components/ui/Misc";
import { AboutPage } from "@/features/about/AboutPage";
import { HostPage } from "@/features/hosts/HostPage";
import { SettingsPage } from "@/features/settings/SettingsPage";
import { UpdatesPage } from "@/features/updates/UpdatesPage";
import { WelcomePage } from "@/features/welcome/WelcomePage";
import { useWorkspace } from "@/store/workspace";

export function TabContent() {
  const { t } = useTranslation();
  const tab = useWorkspace(
    (state) => state.tabs.find((item) => item.id === state.activeId) ?? null,
  );

  if (!tab) {
    return (
      <div className="page">
        <EmptyState title={t("host.emptyTitle")} body={t("host.emptyBody")} />
      </div>
    );
  }

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
    default:
      return null;
  }
}
