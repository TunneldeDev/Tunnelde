import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/form/Button";
import type { ReleaseNotes, UpdateState } from "@/lib/api/types";
import { formatDateTime } from "@/lib/text/format";
import { updateHistoryKey } from "@/lib/updates/stateIdentity";
import type { ReleaseHistory } from "@/lib/api/types";
import { useLocalControlState, type SettingsControlState } from "./controlState";
export interface UpdateNotesServices {
  load(retry?: boolean): Promise<void>;
  renderMarkdown(source: string): ReactNode;
  useViewState?: SettingsControlState;
}
export interface UpdateHistoryProjection {
  key: string;
  loading: boolean;
  data: ReleaseHistory | null;
  error: string | null;
}

function ReleaseEntry({
  entry,
  target,
  services,
}: {
  entry: ReleaseNotes;
  target: string;
  services: UpdateNotesServices;
}) {
  const { t, i18n } = useTranslation();
  const useViewState = services.useViewState ?? useLocalControlState;
  const [open, setOpen] = useViewState(
    `settings:updateNotes:entry:${target}:${entry.version}`,
    entry.version === target,
  );
  return (
    <details
      className="settings-update__release"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        <span className="settings-update__release-version">v{entry.version}</span>
        {entry.version === target ? (
          <span className="settings-update__release-target">{t("updates.historyTarget")}</span>
        ) : null}
        {entry.publishedAt ? (
          <span className="updates__meta">
            {formatDateTime(entry.publishedAt, i18n.resolvedLanguage ?? "en-US")}
          </span>
        ) : null}
      </summary>
      {open ? (
        entry.notes?.trim() ? (
          services.renderMarkdown(entry.notes)
        ) : (
          <p className="settings-row__hint">{t("updates.historyEmpty")}</p>
        )
      ) : null}
    </details>
  );
}

export function UpdateNotesView({
  state,
  history: currentHistory,
  services,
}: {
  state: UpdateState & { version: string };
  history: UpdateHistoryProjection | null;
  services: UpdateNotesServices;
}) {
  const { t } = useTranslation();
  const useViewState = services.useViewState ?? useLocalControlState;
  const [open, setOpen] = useViewState(`settings:updateNotes:${updateHistoryKey(state)}`, false);
  const key = updateHistoryKey(state);
  const history = currentHistory?.key === key ? currentHistory : null;
  const { load } = services;
  const data = history?.data;
  const entries = data?.entries ?? [
    { version: state.version, notes: state.notes, publishedAt: state.publishedAt },
  ];
  const partial = data && !data.complete;
  return (
    <details
      className="settings-update__notes"
      open={open}
      onToggle={(event) => {
        const expanded = event.currentTarget.open;
        setOpen(expanded);
        if (expanded) void load();
      }}
    >
      <summary>
        {t("updates.notes")} · v{state.currentVersion} → v{state.version}
      </summary>
      {open ? (
        <div className="settings-update__history">
          <div className="settings-update__history-info">
            <p className="settings-row__hint" role="status" aria-live="polite">
              {history?.loading
                ? t("updates.historyLoading")
                : history?.error
                  ? t("updates.historyUnavailable")
                  : partial
                    ? t(data.reason ?? "updates.historyUnavailable")
                    : data
                      ? t("updates.historyComplete", { count: entries.length })
                      : t("updates.historyLoading")}
            </p>
            {(history?.error || partial) && data?.reason !== "updates.historyCustom" ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={history?.loading}
                onClick={() => void load(true)}
              >
                {t("common.retry")}
              </Button>
            ) : null}
          </div>
          <p className="settings-row__hint">
            {t(state.channel === "stable" ? "updates.historyStable" : "updates.historyBeta")}
          </p>
          <div className="settings-update__releases" aria-label={t("updates.notes")}>
            {entries.map((entry) => (
              <ReleaseEntry
                key={entry.version}
                entry={entry}
                target={state.version}
                services={services}
              />
            ))}
          </div>
        </div>
      ) : null}
    </details>
  );
}
