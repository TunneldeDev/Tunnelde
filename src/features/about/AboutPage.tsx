// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/form/Button";
import { translateError } from "@/lib/api/errors";
import { api } from "@/lib/api/ipc";
import { toast } from "@/store/toasts";
import { useSettings } from "@/store/settings";

const REPOSITORY = "https://github.com/TunneldeDev/Tunnelde";

function openUrl(url: string): void {
  void api.openExternal(url).catch((error) => toast(translateError(error), "error"));
}

export function AboutPage() {
  const { t } = useTranslation();
  const info = useSettings((state) => state.info);
  const version = info?.version ?? "0.1.0";

  return (
    <div className="page about">
      <section className="card about__head">
        <img src="/brand/mark-256.png" width={64} height={64} alt="" draggable={false} />
        <div className="about__identity">
          <h1 className="about__name">Tunnelde</h1>
          <p className="about__meta">
            {t("about.version")} {version}
            {info ? ` · Tauri ${info.tauriVersion} · ${info.os}/${info.arch}` : ""}
          </p>
        </div>
      </section>

      <section className="card">
        <dl className="detail-grid">
          <div className="detail">
            <dt className="detail__label">{t("about.copyright")}</dt>
            <dd className="detail__value">Copyright (C) 2026 quyansiyuanwang (TunneldeDev)</dd>
          </div>
          <div className="detail">
            <dt className="detail__label">{t("about.license")}</dt>
            <dd className="detail__value">GNU GPL v3.0 only (GPL-3.0-only)</dd>
          </div>
        </dl>
        <p className="about__warranty">{t("about.warranty")}</p>
        <div className="about__links">
          <Button
            variant="ghost"
            size="sm"
            trailing={<ExternalLink size={12} />}
            onClick={() => openUrl(REPOSITORY)}
          >
            {t("about.source")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            trailing={<ExternalLink size={12} />}
            onClick={() => openUrl(`${REPOSITORY}/blob/main/LICENSE`)}
          >
            {t("about.license")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            trailing={<ExternalLink size={12} />}
            onClick={() => openUrl(`${REPOSITORY}/blob/main/THIRD_PARTY_NOTICES.md`)}
          >
            {t("about.thirdParty")}
          </Button>
        </div>
      </section>
    </div>
  );
}
