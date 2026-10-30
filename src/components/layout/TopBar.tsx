// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { ArrowUpCircle, Settings as SettingsIcon } from "lucide-react";
import { useTranslation } from "react-i18next";

import { IconButton } from "@/components/ui/form/Button";
import { useUpdates } from "@/store/updates";
import { useWorkspace } from "@/store/workspace";

export function UpdatePill() {
  const state = useUpdates((value) => value.state);
  const openPage = useWorkspace((value) => value.openPage);

  if (!state?.available || state.skipped || !state.version) {
    return null;
  }

  return (
    <button type="button" className="td-update-pill" onClick={() => openPage("updates")}>
      <ArrowUpCircle size={13} />
      <span>{state.version}</span>
    </button>
  );
}

export function TopBar() {
  const { t } = useTranslation();
  const openPage = useWorkspace((value) => value.openPage);

  return (
    <header className="topbar">
      <div className="topbar__brand" title="Tunnelde">
        <img src="/brand/mark-64.png" alt="" width={18} height={18} draggable={false} />
        <span className="topbar__name">Tunnelde</span>
      </div>

      <div className="topbar__spacer" />

      <div className="topbar__actions">
        <UpdatePill />
        <IconButton label={t("nav.settings")} onClick={() => openPage("settings")}>
          <SettingsIcon size={15} />
        </IconButton>
      </div>
    </header>
  );
}
