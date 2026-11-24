import thirdPartyNotices from "../../../THIRD_PARTY_NOTICES.md?raw";
import { brandMark } from "@/lib/brand";
import { Dialog } from "@/components/ui/overlay/Dialog";
import { ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/form/Button";
import type { AppInfo } from "@/lib/api/types";
import type { SettingsControlState } from "@/features/settings/components/controlState";
export type AboutLink = "source" | "license" | "notices";
export function AboutPageView({
  embedded = false,
  info,
  useViewState,
  openLink,
}: {
  embedded?: boolean;
  info: Pick<AppInfo, "version" | "tauriVersion" | "os" | "arch"> | null;
  useViewState: SettingsControlState;
  openLink(link: AboutLink): void;
}) {
  const { t } = useTranslation();
  const [noticesOpen, setNoticesOpen] = useViewState("settings:about:notices", false);
  const version = info?.version ?? "0.1.0";

  return (
    <div className={embedded ? "about" : "page about"}>
      <section className="card about__head">
        <img src={brandMark} width={64} height={64} alt="" draggable={false} />
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
            onClick={() => openLink("source")}
          >
            {t("about.source")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            trailing={<ExternalLink size={12} />}
            onClick={() => openLink("license")}
          >
            {t("about.license")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            trailing={<ExternalLink size={12} />}
            onClick={() => setNoticesOpen(true)}
          >
            {t("about.thirdParty")}
          </Button>
        </div>
      </section>
      <Dialog
        open={noticesOpen}
        title={t("about.thirdParty")}
        closeLabel={t("common.close")}
        onClose={() => setNoticesOpen(false)}
        width={640}
      >
        <pre style={{ whiteSpace: "pre-wrap", fontFamily: "inherit" }}>{thirdPartyNotices}</pre>
        <Button
          variant="ghost"
          trailing={<ExternalLink size={12} />}
          onClick={() => openLink("notices")}
        >
          {t("about.thirdParty")}
        </Button>
      </Dialog>
    </div>
  );
}
