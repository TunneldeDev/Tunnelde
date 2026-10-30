// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { PanelRightClose, PanelRightOpen } from "lucide-react";
import { useTranslation } from "react-i18next";

import { IconButton } from "@/components/ui/form/Button";
import { StatusDot } from "@/components/ui/display/Misc";
import { useHosts } from "@/store/hosts";
import { useSettings } from "@/store/settings";
import { useWorkspace } from "@/store/workspace";

interface StatusBarProps {
  panelOpen: boolean;
  onTogglePanel: () => void;
}

export function StatusBar({ panelOpen, onTogglePanel }: StatusBarProps) {
  const { t } = useTranslation();
  const info = useSettings((state) => state.info);
  const hostCount = useHosts((state) => state.hosts.length);
  const openPage = useWorkspace((state) => state.openPage);

  return (
    <footer className="statusbar">
      <div className="statusbar__group">
        <StatusDot tone="ok" />
        <span>{t("status.ready")}</span>
        <span className="statusbar__sep" />
        <span className="statusbar__muted">{t("status.hosts", { count: hostCount })}</span>
      </div>
      <div className="statusbar__group">
        <IconButton
          size="sm"
          active={panelOpen}
          label={panelOpen ? t("panel.hide") : t("panel.show")}
          onClick={onTogglePanel}
        >
          {panelOpen ? <PanelRightClose size={13} /> : <PanelRightOpen size={13} />}
        </IconButton>
        <button
          type="button"
          className="statusbar__link"
          onClick={() => openPage("about")}
          aria-label={t("nav.about")}
        >
          {t("status.version", { version: info?.version ?? "0.1.0" })}
        </button>
      </div>
    </footer>
  );
}
