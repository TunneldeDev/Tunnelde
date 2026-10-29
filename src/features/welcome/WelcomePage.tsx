// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { Plus, Settings as SettingsIcon } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/Button";
import { useDialogs } from "@/store/dialogs";
import { useHosts } from "@/store/hosts";
import { useWorkspace } from "@/store/workspace";

export function WelcomePage() {
  const { t } = useTranslation();
  const openHostDialog = useDialogs((state) => state.openHost);
  const openPage = useWorkspace((state) => state.openPage);
  const openHost = useWorkspace((state) => state.openHost);
  const hosts = useHosts((state) => state.hosts);

  const recent = [...hosts]
    .filter((host) => host.lastUsedAt !== null)
    .sort((left, right) => (right.lastUsedAt ?? 0) - (left.lastUsedAt ?? 0))
    .slice(0, 4);

  return (
    <div className="page welcome">
      <div className="welcome__inner">
        <img
          className="welcome__mark"
          src="/brand/mark-256.png"
          width={84}
          height={84}
          alt=""
          draggable={false}
        />
        <h1 className="welcome__title">Tunnelde</h1>
        <p className="welcome__tagline">{t("app.tagline")}</p>

        <div className="welcome__actions">
          <Button variant="primary" leading={<Plus size={14} />} onClick={() => openHostDialog()}>
            {t("welcome.newHost")}
          </Button>
          <Button
            variant="secondary"
            leading={<SettingsIcon size={14} />}
            onClick={() => openPage("settings")}
          >
            {t("welcome.settings")}
          </Button>
        </div>

        {recent.length > 0 ? (
          <div className="welcome__recent">
            <h2 className="welcome__section">{t("welcome.recent")}</h2>
            <div className="welcome__chips">
              {recent.map((host) => (
                <button
                  key={host.id}
                  type="button"
                  className="td-chip"
                  onClick={() => openHost(host)}
                >
                  {host.name}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        <p className="welcome__hint">{t("welcome.hint")}</p>
      </div>
    </div>
  );
}
