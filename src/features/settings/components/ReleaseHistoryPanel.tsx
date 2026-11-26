import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { History } from "lucide-react";
import { Button } from "@/components/ui/form/Button";
import type { ReleaseHistory } from "@/lib/api/types";
import { presentError } from "@/lib/api/errors";
import { formatDateTime } from "@/lib/text/format";
import { useLocalControlState, type SettingsControlState } from "./controlState";

export function ReleaseHistoryPanel({
  channel,
  load,
  renderMarkdown,
  useViewState = useLocalControlState,
}: {
  channel: string;
  load(): Promise<ReleaseHistory>;
  renderMarkdown(source: string): ReactNode;
  useViewState?: SettingsControlState;
}) {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useViewState("settings:releaseHistory:open", false);
  const [attempt, retry] = useState(0);
  const [result, setResult] = useState<{
    channel: string;
    attempt: number;
    data?: ReleaseHistory;
    error?: string;
  } | null>(null);
  const loader = useRef(load);
  useEffect(() => {
    loader.current = load;
  }, [load]);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void loader.current().then(
      (data) => {
        if (!cancelled) setResult({ channel, attempt, data });
      },
      (error) => {
        if (!cancelled) setResult({ channel, attempt, error: presentError(error) });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [open, channel, attempt]);
  const current = result?.channel === channel && result.attempt === attempt ? result : null;
  return (
    <section className="settings-update__archive">
      <Button
        size="sm"
        variant="ghost"
        leading={<History size={13} />}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {t("updates.releaseHistory")}
      </Button>
      {open ? (
        <div className="settings-update__releases" aria-label={t("updates.releaseHistory")}>
          <p className="settings-row__hint">{t("updates.releaseHistoryHint")}</p>
          {!current ? <p role="status">{t("updates.historyLoading")}</p> : null}
          {current?.error || (current?.data && !current.data.complete) ? (
            <div>
              <p role="status">
                {current.error ?? t(current.data?.reason ?? "updates.historyUnavailable")}
              </p>
              <Button size="sm" onClick={() => retry((value) => value + 1)}>
                {t("common.retry")}
              </Button>
            </div>
          ) : null}
          {current?.data?.entries.length === 0 ? <p>{t("updates.releaseHistoryEmpty")}</p> : null}
          {current?.data?.entries.map((entry) => (
            <ReleaseEntry
              key={`${channel}:${entry.version}`}
              entry={entry}
              locale={i18n.resolvedLanguage ?? "en-US"}
              renderMarkdown={renderMarkdown}
              emptyLabel={t("updates.historyEmpty")}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}

function ReleaseEntry({
  entry,
  locale,
  renderMarkdown,
  emptyLabel,
}: {
  entry: ReleaseHistory["entries"][number];
  locale: string;
  renderMarkdown(source: string): ReactNode;
  emptyLabel: string;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <details
      className="settings-update__release"
      onToggle={(event) => setExpanded(event.currentTarget.open)}
    >
      <summary>
        <span className="settings-update__release-version">v{entry.version}</span>
        {entry.publishedAt ? (
          <span className="updates__meta">{formatDateTime(entry.publishedAt, locale)}</span>
        ) : null}
      </summary>
      {expanded ? entry.notes?.trim() ? renderMarkdown(entry.notes) : <p>{emptyLabel}</p> : null}
    </details>
  );
}
