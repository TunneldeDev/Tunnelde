import { CornerDownLeft, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";

import { Button, IconButton } from "@/components/ui/form/Button";
import { SearchField } from "@/components/ui/form/SearchField";
import { matchesSearch, matchesSearchDate, parseSearchQuery } from "@/lib/search/query";
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
import { HistorySurface } from "./HistorySurface";
import { createHistoryStore } from "./historyStore";

const NO_ENTRIES: readonly HistoryEntry[] = Object.freeze([]);

export function HistoryPage({ sessionId }: { sessionId: string }) {
  const { t, i18n } = useTranslation();
  const session = useSsh((state) => state.sessions.find((item) => item.id === sessionId) ?? null);
  const confirm = useDialogs((state) => state.confirm);
  const [query, setQuery] = useState("");
  const hostId = session?.hostId ?? null;
  const store = useMemo(
    () =>
      createHistoryStore(
        () => (hostId ? api.historyList(hostId, 500) : Promise.resolve([])),
        (error) => toast(translateError(error), "error"),
      ),
    [hostId],
  );
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const entries = snapshot.entries;

  useEffect(() => {
    const lifetime = new AbortController();
    void domainEvents.onHistory(({ hostId: changedHost }) => {
      if (!changedHost || changedHost === hostId) store.refresh();
    }, lifetime.signal);
    const stop = store.start();
    return () => {
      lifetime.abort();
      stop();
    };
  }, [hostId, store]);

  if (!session) {
    return (
      <div className="page">
        <EmptyState title={t("sftp.noSession")} />
      </div>
    );
  }

  const search = parseSearchQuery(query, ["command", "date"]);
  const filtered = (hostId ? (entries ?? NO_ENTRIES) : NO_ENTRIES).filter((entry) =>
    matchesSearch(search, entry.command, {
      command: (value) => entry.command.toLocaleLowerCase().includes(value),
      date: (value) => matchesSearchDate(entry.executedAt, value),
    }),
  );

  const validate = () => {
    const current = useSsh.getState().sessions.find((item) => item.id === session.id);
    return current?.hostId === hostId && store.getSnapshot() === snapshot;
  };
  const insert = async (entry: Readonly<HistoryEntry>) => {
    if (!validate() || snapshot.busy || snapshot.error) throw new Error("plugin.history.changed");
    await api.sshWrite(session.id, encodeBase64(`${entry.command}\r`));
    await recordTerminalCommand(session.hostId, entry.command);
  };
  const remove = async (entry: Readonly<HistoryEntry>) => {
    if (!validate() || snapshot.busy || snapshot.error) throw new Error("plugin.history.changed");
    await api.historyDelete(entry.id);
    notifyHistoryChanged(session.hostId);
  };

  const clear = (authorize: () => void = () => {}) => {
    confirm({
      title: t("history.clearTitle"),
      body: t("history.clearBody", { name: session.title }),
      confirmLabel: t("history.clear"),
      danger: true,
      onConfirm: async () => {
        try {
          authorize();
          // Recheck the session when the user confirms, not only when opening the dialog.
          if (useSsh.getState().sessions.find((item) => item.id === session.id)?.hostId !== hostId)
            throw new Error("plugin.history.changed");
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
        <SearchField
          value={query}
          spellCheck={false}
          placeholder={t("history.search")}
          aria-label={t("history.search")}
          onChange={setQuery}
          presets={[
            { key: "command", value: "", label: t("searchUi.command") },
            { key: "date", value: "", label: t("searchUi.date") },
          ]}
        />
        <span className="history-head__count">
          {t("history.count", { count: filtered.length })}
        </span>
        <Button
          variant="ghost"
          size="sm"
          leading={<Trash2 size={13} />}
          disabled={snapshot.busy || !!snapshot.error || !entries || entries.length === 0}
          onClick={() => clear()}
        >
          {t("history.clear")}
        </Button>
      </header>

      {snapshot.error ? (
        <div className="history-error" role="alert">
          <span>{translateError(snapshot.error)}</span>
          <Button variant="ghost" size="sm" onClick={store.refresh}>
            {t("common.retry")}
          </Button>
        </div>
      ) : null}
      <HistorySurface
        sessionId={session.id}
        hostId={session.hostId}
        title={session.title}
        query={query}
        entries={filtered}
        busy={snapshot.busy}
        error={snapshot.error ? translateError(snapshot.error) : null}
        actions={{
          validate,
          setQuery,
          refresh: store.refresh,
          delete: remove,
          requestClear: clear,
          execute: insert,
        }}
      >
        <div className="history-list" aria-busy={snapshot.busy}>
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
                <IconButton
                  label={t("history.insert")}
                  size="sm"
                  disabled={snapshot.busy || !!snapshot.error}
                  onClick={() =>
                    void insert(entry).catch((error) => toast(translateError(error), "error"))
                  }
                >
                  <CornerDownLeft size={12} />
                </IconButton>
                <IconButton
                  label={t("history.delete")}
                  size="sm"
                  danger
                  disabled={snapshot.busy || !!snapshot.error}
                  onClick={() =>
                    void remove(entry).catch((error) => toast(translateError(error), "error"))
                  }
                >
                  <Trash2 size={12} />
                </IconButton>
              </span>
            </div>
          ))}
        </div>
      </HistorySurface>
    </div>
  );
}
