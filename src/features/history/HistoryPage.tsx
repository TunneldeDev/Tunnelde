import { CornerDownLeft, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button, IconButton } from "@/components/ui/form/Button";
import { Input } from "@/components/ui/form/Field";
import { EmptyState } from "@/components/ui/display/Misc";
import { encodeBase64 } from "@/lib/text/base64";
import { notifyHistoryChanged, recordTerminalCommand } from "@/lib/session/history";
import { translateError } from "@/lib/api/errors";
import { formatRelative } from "@/lib/text/format";
import { domainEvents } from "@/lib/events/domain";
import { api } from "@/lib/api/ipc";
import type { HistoryEntry } from "@/lib/api/types";
import { useDialogs } from "@/store/dialogs";
import { useSsh } from "@/store/ssh";
import { toast } from "@/store/toasts";

export function HistoryPage({ sessionId }: { sessionId: string }) {
  const { t, i18n } = useTranslation();
  const session = useSsh((state) => state.sessions.find((item) => item.id === sessionId) ?? null);
  const confirm = useDialogs((state) => state.confirm);
  const [snapshot, setSnapshot] = useState<{ hostId: string; entries: HistoryEntry[] } | null>(
    null,
  );
  const [query, setQuery] = useState("");
  const hostId = session?.hostId ?? null;
  const entries = snapshot?.hostId === hostId ? snapshot.entries : null;

  useEffect(() => {
    let alive = true;
    let revision = 0;
    const load = () => {
      if (!hostId) return;
      const requested = ++revision;
      void api
        .historyList(hostId)
        .then((list) => {
          if (alive && revision === requested) setSnapshot({ hostId, entries: list });
        })
        .catch((error: unknown) => {
          if (alive && revision === requested) toast(translateError(error), "error");
        });
    };
    const lifetime = new AbortController();
    void domainEvents.onHistory(({ hostId: changedHost }) => {
      if (!changedHost || changedHost === hostId) load();
    }, lifetime.signal);
    load();
    return () => {
      alive = false;
      lifetime.abort();
    };
  }, [hostId]);

  if (!session) {
    return (
      <div className="page">
        <EmptyState title={t("sftp.noSession")} />
      </div>
    );
  }

  const filtered = (hostId ? (entries ?? []) : []).filter((entry) =>
    entry.command.toLowerCase().includes(query.trim().toLowerCase()),
  );

  const insert = (entry: HistoryEntry) => {
    void api
      .sshWrite(session.id, encodeBase64(`${entry.command}\r`))
      .then(() => recordTerminalCommand(session.hostId, entry.command))
      .catch((error) => toast(translateError(error), "error"));
  };

  const remove = (entry: HistoryEntry) => {
    void api
      .historyDelete(entry.id)
      .then(() => notifyHistoryChanged(session.hostId))
      .catch((error) => toast(translateError(error), "error"));
  };

  const clear = () => {
    confirm({
      title: t("history.clearTitle"),
      body: t("history.clearBody", { name: session.title }),
      confirmLabel: t("history.clear"),
      danger: true,
      onConfirm: async () => {
        try {
          await api.historyClear(session.hostId);
          notifyHistoryChanged(session.hostId);
        } catch (error) {
          toast(translateError(error), "error");
        }
      },
    });
  };

  const locale = i18n.resolvedLanguage ?? "en-US";

  return (
    <div className="history-page">
      <header className="history-head">
        <Input
          value={query}
          spellCheck={false}
          placeholder={t("history.search")}
          aria-label={t("history.search")}
          onChange={(event) => setQuery(event.target.value)}
        />
        <span className="history-head__count">
          {t("history.count", { count: filtered.length })}
        </span>
        <Button
          variant="ghost"
          size="sm"
          leading={<Trash2 size={13} />}
          disabled={!entries || entries.length === 0}
          onClick={clear}
        >
          {t("history.clear")}
        </Button>
      </header>

      <div className="history-list">
        {entries !== null && filtered.length === 0 ? (
          <p className="history-empty">{t("history.empty")}</p>
        ) : null}
        {filtered.map((entry) => (
          <div className="history-row" key={entry.id}>
            <code className="history-row__command" title={entry.command}>
              {entry.command}
            </code>
            <span className="history-row__time">{formatRelative(entry.executedAt, locale)}</span>
            <span className="history-row__actions">
              <IconButton label={t("history.insert")} size="sm" onClick={() => insert(entry)}>
                <CornerDownLeft size={12} />
              </IconButton>
              <IconButton
                label={t("history.delete")}
                size="sm"
                danger
                onClick={() => remove(entry)}
              >
                <Trash2 size={12} />
              </IconButton>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
