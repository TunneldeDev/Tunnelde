// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)
import { useTranslation } from "react-i18next";
import { KnownHostsList } from "./KnownHostsList";

export function KnownHostsPage() {
  const { t } = useTranslation();
  return (
    <div className="page known-hosts-page">
      <h1>{t("settings.knownHosts")}</h1>
      <p className="settings-hint">{t("settings.knownHostsDescription")}</p>
      <KnownHostsList />
    </div>
  );
}
