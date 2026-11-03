import { Download, ExternalLink, RefreshCw, RotateCcw } from "lucide-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button, IconButton } from "@/components/ui/form/Button";
import { Input } from "@/components/ui/form/Field";
import { PluginMarkdown } from "@/features/plugins/PluginMarkdown";
import { api, isTauri } from "@/lib/api/ipc";
import { translateError } from "@/lib/api/errors";
import { formatBytes, formatDateTime } from "@/lib/text/format";
import { useSettings } from "@/store/settings";
import { matchingUpdateState, useUpdates } from "@/store/updates";
import { toast } from "@/store/toasts";

export function validUpdateSource(value: string): boolean {
  if (
    value.length > 2048 ||
    /\s/.test(value) ||
    [...value].some(
      (character) =>
        character.charCodeAt(0) < 32 ||
        (character.charCodeAt(0) >= 127 && character.charCodeAt(0) <= 159),
    ) ||
    value.split("{channel}").length !== 2
  )
    return false;
  try {
    const replaced = value.replace("{channel}", "tunnelde-update-channel");
    if (/[{}\\]/.test(replaced)) return false;
    const url = new URL(replaced);
    return (
      url.protocol === "https:" &&
      Boolean(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.hash &&
      !url.search &&
      url.pathname.includes("tunnelde-update-channel") &&
      !url.hostname.includes("tunnelde-update-channel")
    );
  } catch {
    return false;
  }
}

export function UpdateSourceUrl({ onReset }: { onReset: () => void }) {
  const { t } = useTranslation();
  const id = useId();
  const value = useSettings((store) => store.settings.updateSourceUrl);
  const source = useSettings((store) => store.settings.updateSource);
  const saving = useSettings((store) => store.saving);
  const update = useSettings((store) => store.update);
  const updatesBusy = useUpdates(
    (store) => store.busy || store.state?.phase === "downloading" || store.state?.phase === "ready",
  );
  const [draft, setDraft] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const text = draft ?? value;
  const disabled = source !== "custom" || updatesBusy;
  const valid = validUpdateSource(text);
  const dirty = text !== value;
  const apply = async () => {
    if (!valid || !dirty || applying) return;
    const submitted = text;
    setApplying(true);
    try {
      if (await update({ updateSourceUrl: submitted })) {
        setDraft((current) => (current === submitted ? null : current));
      }
    } finally {
      setApplying(false);
    }
  };
  return (
    <div
      className={`settings-row settings-update-source${disabled ? " is-disabled" : ""}`}
      data-setting="updateSourceUrl"
    >
      <div className="settings-row__text">
        <label className="settings-row__label" htmlFor={id}>
          {t("updates.sourceUrl")}
        </label>
        <p className="settings-row__hint" id={`${id}-hint`}>
          {t("updates.sourceUrlHint")}
        </p>
      </div>
      <div className="settings-update-source__editor">
        <div className="settings-update-source__input">
          <Input
            id={id}
            type="url"
            value={text}
            disabled={disabled || applying}
            aria-describedby={`${id}-hint`}
            aria-invalid={!disabled && Boolean(text) && !valid}
            placeholder="https://updates.example.com/{channel}/latest.json"
            spellCheck={false}
            autoComplete="off"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void apply();
              }
              if (event.key === "Escape") setDraft(null);
            }}
          />
          <Button
            size="sm"
            disabled={disabled || !valid || !dirty || applying || saving}
            onClick={() => void apply()}
          >
            {t("common.apply")}
          </Button>
          <IconButton
            size="sm"
            label={t("settings.restoreOne", { name: t("updates.sourceUrl") })}
            disabled={updatesBusy || (!value && !draft)}
            onClick={() => {
              setDraft(null);
              onReset();
            }}
          >
            <RotateCcw size={13} />
          </IconButton>
        </div>
        {!disabled && text && !valid ? (
          <p role="alert" className="settings-message is-error">
            {t("updates.invalidSource")}
          </p>
        ) : null}
        {!disabled && dirty && valid ? (
          <p className="settings-row__hint" role="status">
            {t("updates.sourceDraft")}
          </p>
        ) : null}
      </div>
    </div>
  );
}

const REASONS = {
  dev: "updates.unsupportedDev",
  unsigned: "updates.unsupportedUnsigned",
  package: "updates.unsupportedPackage",
  unsupported: "updates.unsupportedOther",
} as const;

export function UpdateStatus() {
  const { t, i18n } = useTranslation();
  const settings = useSettings((store) => store.settings);
  const info = useSettings((store) => store.info);
  const saving = useSettings((store) => store.saving);
  const state = useUpdates((store) => matchingUpdateState(store.state, settings));
  const busy = useUpdates((store) => store.busy);
  const check = useUpdates((store) => store.check);
  const install = useUpdates((store) => store.install);
  const skip = useUpdates((store) => store.skip);
  const phase = state?.phase ?? "idle";
  const downloading = phase === "downloading";
  const checking = phase === "checking" || (busy && !downloading);
  const percent = state?.contentLength
    ? Math.min(100, Math.round(((state.progress ?? 0) / state.contentLength) * 100))
    : undefined;
  const locale = i18n.resolvedLanguage ?? "en-US";
  const current = state?.currentVersion ?? info?.version;
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
      ? translateError({ code: "update", message: state.error })
      : t("updates.error");
  const openRelease = () =>
    void api.openReleasePage().catch((error) => toast(translateError(error), "error"));
  const canCheck =
    isTauri() &&
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
          disabled={!isTauri()}
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
      {state?.notes ? (
        <details className="settings-update__notes" key={`${state.source}:${state.version}`}>
          <summary>
            {t("updates.notes")}
            {state.version ? ` · v${state.version}` : ""}
          </summary>
          {state.publishedAt ? (
            <p className="updates__meta">
              {t("updates.publishedAt")}: {formatDateTime(state.publishedAt, locale)}
            </p>
          ) : null}
          <PluginMarkdown source={state.notes} />
        </details>
      ) : null}
    </div>
  );
}
