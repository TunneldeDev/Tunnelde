import { Download, ExternalLink, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/form/Button";
import type { Settings, UpdateState, UpdateSourceFailure } from "@/lib/api/types";
import { presentError } from "@/lib/api/errors";
import { formatBytes, formatDateTime } from "@/lib/text/format";
import { validUpdateSource } from "@/lib/updates/sourceValidation";

const REASONS = {
  dev: "updates.unsupportedDev",
  unsigned: "updates.unsupportedUnsigned",
  location: "updates.macInstallLocation",
  package: "updates.unsupportedPackage",
  unsupported: "updates.unsupportedOther",
} as const;

export interface UpdateStatusServices {
  check(force?: boolean): Promise<void>;
  install(): Promise<void>;
  skip(): Promise<void>;
  openRelease(): void;
  renderDiagnostics(failures: UpdateSourceFailure[]): ReactNode;
  renderNotes(state: UpdateState & { version: string }): ReactNode;
}
export function UpdateStatusView({
  settings,
  version,
  saving,
  state,
  busy,
  nativeAvailable,
  services,
}: {
  settings: Pick<
    Settings,
    "updateChannel" | "updateSource" | "updateSourceUrl" | "lastUpdateCheck"
  >;
  version?: string;
  saving: boolean;
  state: UpdateState | null;
  busy: boolean;
  nativeAvailable: boolean;
  services: UpdateStatusServices;
}) {
  const { t, i18n } = useTranslation();
  const { check, install, skip, openRelease } = services;
  const phase = state?.phase ?? "idle";
  const downloading = phase === "downloading";
  const checking = phase === "checking" || (busy && !downloading);
  const percent = state?.contentLength
    ? Math.min(100, Math.round(((state.progress ?? 0) / state.contentLength) * 100))
    : undefined;
  const locale = i18n.resolvedLanguage ?? "en-US";
  const current = state?.currentVersion ?? version;
  const lastChecked = state?.lastChecked ?? settings.lastUpdateCheck;
  const reason =
    REASONS[(state?.unsupportedReason ?? "unsupported") as keyof typeof REASONS] ??
    REASONS.unsupported;
  let status = t("updates.current");
  if (checking) status = t("updates.checking");
  else if (phase === "upToDate") status = t("updates.upToDate");
  else if (phase === "available" && state?.version)
    status = t("updates.available", { version: state.version });
  else if (downloading)
    status =
      percent === undefined
        ? t("updates.downloadingBytes", { size: formatBytes(state?.progress ?? 0) })
        : t("updates.downloading", { percent });
  else if (phase === "ready") status = t("updates.ready");
  else if (phase === "unsupported") status = t(reason);
  else if (phase === "error")
    status = state?.error
      ? presentError({ code: "update", message: state.error })
      : t("updates.error");
  const canCheck =
    nativeAvailable &&
    !busy &&
    !downloading &&
    !saving &&
    (settings.updateSource !== "custom" || validUpdateSource(settings.updateSourceUrl));
  return (
    <div className="settings-update" aria-label={t("updates.title")}>
      <div className="settings-update__head">
        <div>
          <span className="settings-row__hint">{t("updates.current")}</span>
          <p className="settings-update__version">{current ? `v${current}` : "—"}</p>
        </div>
        <span className="settings-update__channel">{t(`updates.${settings.updateChannel}`)}</span>
      </div>
      <p className={`updates__status${state?.available ? " is-available" : ""}`} role="status">
        {status}
      </p>
      {phase === "error" && state?.sourceErrors?.length
        ? services.renderDiagnostics(state.sourceErrors)
        : null}
      {downloading ? (
        <div
          className={`td-progress${percent === undefined ? " is-indeterminate" : ""}`}
          role="progressbar"
          aria-label={t("updates.install")}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-valuetext={status}
        >
          <div
            className="td-progress__fill"
            style={{ width: percent === undefined ? "35%" : `${percent}%` }}
          />
        </div>
      ) : null}
      <div className="updates__actions">
        <Button
          size="sm"
          leading={<RefreshCw size={14} />}
          disabled={!canCheck}
          onClick={() => void check(true)}
        >
          {checking ? t("updates.checking") : t("updates.check")}
        </Button>
        {state?.available && state.autoInstall ? (
          <Button
            size="sm"
            variant="primary"
            leading={<Download size={14} />}
            disabled={busy || downloading || saving}
            onClick={() => void install()}
          >
            {t("updates.install")}
          </Button>
        ) : null}
        {state?.available && !state.autoInstall ? (
          <Button size="sm" leading={<Download size={14} />} onClick={openRelease}>
            {t("updates.manual")}
          </Button>
        ) : null}
        {state?.available && !state.skipped ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || downloading}
            onClick={() => void skip()}
          >
            {t("updates.skip")}
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="ghost"
          leading={<ExternalLink size={13} />}
          disabled={!nativeAvailable}
          onClick={openRelease}
        >
          {t("updates.openRelease")}
        </Button>
      </div>
      <p className="updates__meta">
        {t("updates.lastChecked")}:{" "}
        {lastChecked ? formatDateTime(lastChecked, locale) : t("common.never")}
        {state?.skipped ? ` · ${t("updates.skipped")}` : ""}
      </p>
      {state?.available && !state.autoInstall && state.unsupportedReason ? (
        <p className="settings-row__hint">{t(reason)}</p>
      ) : null}
      {settings.updateChannel === "stable" && current?.includes("-") ? (
        <p className="settings-row__hint">{t("updates.waitForStable")}</p>
      ) : null}
      <p className="settings-row__hint">{t("updates.installHint")}</p>
      {state?.available && state.version
        ? services.renderNotes({ ...state, version: state.version })
        : null}
    </div>
  );
}
