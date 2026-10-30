// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { Download, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/form/Button";
import { formatDateTime } from "@/lib/text/format";
import { api } from "@/lib/api/ipc";
import { useSettings } from "@/store/settings";
import { useUpdates } from "@/store/updates";

const REASON_KEYS = {
  dev: "updates.unsupportedDev",
  unsigned: "updates.unsupportedUnsigned",
  package: "updates.unsupportedPackage",
  unsupported: "updates.unsupportedOther",
} as const;

type Reason = keyof typeof REASON_KEYS;

function reasonKey(reason: string | null) {
  return REASON_KEYS[(reason ?? "unsupported") as Reason] ?? REASON_KEYS.unsupported;
}

export function UpdatesPage() {
  const { t, i18n } = useTranslation();
  const state = useUpdates((store) => store.state);
  const busy = useUpdates((store) => store.busy);
  const check = useUpdates((store) => store.check);
  const install = useUpdates((store) => store.install);
  const skip = useUpdates((store) => store.skip);
  const info = useSettings((store) => store.info);
  const locale = i18n.resolvedLanguage ?? "en-US";

  const phase = state?.phase ?? "idle";
  const checking = busy || phase === "checking";
  const downloading = phase === "downloading";
  const percent = state?.contentLength
    ? Math.min(100, Math.round(((state.progress ?? 0) / state.contentLength) * 100))
    : 0;

  let status = t("updates.upToDate");
  if (phase === "idle") {
    status = t("updates.current");
  } else if (phase === "checking") {
    status = t("updates.checking");
  } else if (phase === "available" && state?.version) {
    status = t("updates.available", { version: state.version });
  } else if (downloading) {
    status = t("updates.downloading", { percent });
  } else if (phase === "ready") {
    status = t("updates.ready");
  } else if (phase === "unsupported") {
    status = t(reasonKey(state?.unsupportedReason ?? null));
  } else if (phase === "error") {
    status = state?.error ? `${t("updates.error")}: ${state.error}` : t("updates.error");
  }

  const canInstall = Boolean(state?.available && state.autoInstall && !state.skipped);
  const canDownload = Boolean(state?.available && !state.autoInstall);

  return (
    <div className="page updates">
      <section className="card updates__hero">
        <p className="updates__label">{t("updates.current")}</p>
        <p className="updates__version">v{state?.currentVersion ?? info?.version ?? "0.1.0"}</p>
        <p className={phase === "available" ? "updates__status is-available" : "updates__status"}>
          {status}
        </p>

        {downloading ? (
          <div
            className="td-progress"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={percent}
          >
            <div className="td-progress__fill" style={{ width: `${percent}%` }} />
          </div>
        ) : null}

        <div className="updates__actions">
          <Button
            variant="primary"
            leading={<RefreshCw size={14} />}
            disabled={checking || downloading}
            onClick={() => void check(true)}
          >
            {checking ? t("updates.checking") : t("updates.check")}
          </Button>

          {canInstall ? (
            <Button
              variant="secondary"
              leading={<Download size={14} />}
              disabled={busy}
              onClick={() => void install()}
            >
              {t("updates.install")}
            </Button>
          ) : null}

          {canDownload ? (
            <Button
              variant="secondary"
              leading={<Download size={14} />}
              onClick={() => void api.openReleasePage().catch(() => undefined)}
            >
              {t("updates.manual")}
            </Button>
          ) : null}

          {state?.available && !state.skipped ? (
            <Button variant="ghost" onClick={() => void skip()}>
              {t("updates.skip")}
            </Button>
          ) : null}
        </div>

        <p className="updates__meta">
          {t("updates.lastChecked")}:{" "}
          {state?.lastChecked ? formatDateTime(state.lastChecked, locale) : t("common.never")}
          {state?.skipped ? ` · ${t("updates.skipped")}` : ""}
        </p>
      </section>

      {state?.available && state.notes ? (
        <section className="card">
          <h2 className="card__title">{t("updates.notes")}</h2>
          {state.publishedAt ? (
            <p className="updates__meta">
              {t("updates.publishedAt")}: {formatDateTime(state.publishedAt, locale)}
            </p>
          ) : null}
          <pre className="updates__notes">{state.notes}</pre>
        </section>
      ) : null}
    </div>
  );
}
