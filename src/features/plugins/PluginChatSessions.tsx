import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Pencil, Trash2, X } from "lucide-react";
import { Button, IconButton } from "@/components/ui/form/Button";
import { Input } from "@/components/ui/form/Field";
import { Dialog } from "@/components/ui/overlay/Dialog";
import { chatSessionTitle, type ChatSession } from "@/lib/plugins/pluginChat";

export function PluginChatSessions({
  sessions,
  activeId,
  activeRunning,
  busy,
  error,
  suspended = false,
  onClose,
  onAction,
}: {
  sessions: ChatSession[];
  activeId: string;
  activeRunning: boolean;
  busy: boolean;
  error: string | null;
  suspended?: boolean;
  onClose: () => void;
  onAction: (
    action: "select" | "rename" | "delete",
    sessionId: string,
    title?: string,
  ) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const title = (session: ChatSession) => chatSessionTitle(session, t("pluginChat.untitled"));
  const matches = [...sessions]
    .reverse()
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    .filter((session) =>
      title(session).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()),
    );
  const reset = (id: string) => {
    setEditing(null);
    setDeleting(null);
    requestAnimationFrame(() =>
      list.current?.querySelector<HTMLButtonElement>(`[data-session-id="${id}"]`)?.focus(),
    );
  };
  const rename = async (id: string) => {
    if (name.trim() && (await onAction("rename", id, name.trim()))) reset(id);
  };
  return (
    <Dialog
      open={!suspended}
      title={t("pluginChat.sessionHistory")}
      closeLabel={t("common.close")}
      onClose={onClose}
      width={520}
      className="plugin-chat-history"
      dismissible={!busy}
    >
      <Input
        autoFocus
        type="search"
        aria-label={t("pluginChat.searchSessions")}
        placeholder={t("pluginChat.searchSessions")}
        value={query}
        disabled={busy}
        onChange={(event) => {
          setQuery(event.target.value);
          setEditing(null);
          setDeleting(null);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const buttons = list.current?.querySelectorAll<HTMLButtonElement>(
              "button[data-session-id]:not(:disabled)",
            );
            (event.key === "ArrowUp" ? buttons?.[buttons.length - 1] : buttons?.[0])?.focus();
          } else if (event.key === "Enter" && matches[0] && !event.nativeEvent.isComposing) {
            event.preventDefault();
            void onAction("select", matches[0].id).then((ok) => {
              if (ok) onClose();
            });
          }
        }}
      />
      <div
        ref={list}
        className="plugin-chat-history__list"
        role="group"
        aria-label={t("pluginChat.sessionHistory")}
        onKeyDown={(event) => {
          if (event.target instanceof HTMLInputElement) return;
          if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
          const buttons = Array.from(
            list.current?.querySelectorAll<HTMLButtonElement>(
              "button[data-session-id]:not(:disabled)",
            ) ?? [],
          );
          if (!buttons.length) return;
          event.preventDefault();
          const row = (event.target as HTMLElement).closest(".plugin-chat-history__row");
          const index = buttons.indexOf(
            row?.querySelector<HTMLButtonElement>("button[data-session-id]") ??
              (document.activeElement as HTMLButtonElement),
          );
          const next =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? buttons.length - 1
                : (index + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length;
          buttons[next]?.focus();
        }}
      >
        {matches.map((session) => {
          const label = title(session);
          const running = session.running || (session.id === activeId && activeRunning);
          return (
            <div
              className={`plugin-chat-history__row${session.id === activeId ? " is-active" : ""}`}
              key={session.id}
            >
              {editing === session.id ? (
                <form
                  className="plugin-chat-history__edit"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void rename(session.id);
                  }}
                >
                  <Input
                    autoFocus
                    aria-label={t("pluginChat.sessionName")}
                    value={name}
                    maxLength={120}
                    disabled={busy}
                    onChange={(event) => setName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.nativeEvent.isComposing && event.key === "Escape") return;
                      if (event.key === "Escape") {
                        event.preventDefault();
                        event.stopPropagation();
                        reset(session.id);
                      }
                      if (event.key === "Enter" && event.nativeEvent.isComposing)
                        event.preventDefault();
                    }}
                  />
                  <IconButton
                    label={t("common.save")}
                    type="submit"
                    disabled={busy || !name.trim()}
                  >
                    <Check size={14} />
                  </IconButton>
                  <IconButton
                    label={t("common.cancel")}
                    disabled={busy}
                    onClick={() => reset(session.id)}
                  >
                    <X size={14} />
                  </IconButton>
                </form>
              ) : deleting === session.id ? (
                <div
                  className="plugin-chat-history__confirm"
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      event.stopPropagation();
                      reset(session.id);
                    }
                  }}
                >
                  <span>{t("pluginChat.deleteNamedConfirm", { name: label })}</span>
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={busy || running}
                    onClick={async () => {
                      if (await onAction("delete", session.id)) {
                        setDeleting(null);
                        requestAnimationFrame(() =>
                          list.current
                            ?.querySelector<HTMLButtonElement>("button[data-session-id]")
                            ?.focus(),
                        );
                      }
                    }}
                  >
                    {t("common.delete")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => reset(session.id)}
                  >
                    {t("common.cancel")}
                  </Button>
                </div>
              ) : (
                <>
                  <button
                    type="button"
                    className="plugin-chat-history__open"
                    data-session-id={session.id}
                    aria-current={session.id === activeId ? "true" : undefined}
                    disabled={busy}
                    title={label}
                    onClick={async () => {
                      if (await onAction("select", session.id)) onClose();
                    }}
                  >
                    <span>{label}</span>
                    {running ? <small>{t("pluginChat.streaming")}</small> : null}
                    {session.id === activeId ? <Check size={13} aria-hidden="true" /> : null}
                  </button>
                  <IconButton
                    label={t("pluginChat.renameNamed", { name: label })}
                    disabled={busy}
                    onClick={() => {
                      setDeleting(null);
                      setEditing(session.id);
                      setName(label);
                    }}
                  >
                    <Pencil size={13} />
                  </IconButton>
                  <IconButton
                    label={t("pluginChat.deleteNamed", { name: label })}
                    disabled={busy || running}
                    onClick={() => {
                      setEditing(null);
                      setDeleting(session.id);
                    }}
                  >
                    <Trash2 size={13} />
                  </IconButton>
                </>
              )}
            </div>
          );
        })}
        {!matches.length ? (
          <p className="plugin-chat-history__empty">{t("pluginChat.noSessions")}</p>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="plugin-chat-history__error">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}
