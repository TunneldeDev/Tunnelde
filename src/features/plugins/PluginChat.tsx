import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowDown, Copy, Plus, Send, Settings2, Square, Trash2 } from "lucide-react";
import { Button, IconButton } from "@/components/ui/form/Button";
import { Textarea } from "@/components/ui/form/Field";
import { Select } from "@/components/ui/form/Select";
import { api, events, isTauri } from "@/lib/api/ipc";
import { translateError } from "@/lib/api/errors";
import {
  CHAT_MODES,
  applyChatEvent,
  chatRecord,
  normalizeChatBlock,
  type ChatMode,
  type PluginChatBlock,
} from "@/lib/plugins/pluginChat";
import { PLUGIN_INPUT_MAX_BYTES } from "@/lib/plugins/pluginView";
import { copyText } from "@/lib/session/clipboard";
import { authorizePluginAction, reportPluginExecutionFailure } from "@/store/pluginSecurity";
import { useDialogs } from "@/store/dialogs";
import { PluginMarkdown } from "./PluginMarkdown";
import { PluginChatConfigDialog } from "./PluginChatConfig";
import "@/styles/pluginChat.css";

export function PluginChat({
  pluginId,
  viewId,
  block: initial,
}: {
  pluginId: string;
  viewId: string;
  block: PluginChatBlock;
}) {
  const { t, i18n } = useTranslation();
  const [block, setBlock] = useState(initial);
  const current = useRef(block);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const pending = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [streamFailed, setStreamFailed] = useState(false);
  const [streamAttempt, setStreamAttempt] = useState(0);
  const [configOpen, setConfigOpen] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const viewport = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const lifetime = useRef(0);
  const generation = useRef(-1);
  const subscription = useRef<Promise<void>>(Promise.resolve());
  const inputId = useId();
  const appDialogOpen = useDialogs((state) => state.dialog.kind !== "none");
  const update = (next: PluginChatBlock | ((previous: PluginChatBlock) => PluginChatBlock)) => {
    const value = typeof next === "function" ? next(current.current) : next;
    current.current = value;
    setBlock(value);
  };
  useEffect(() => {
    // Refreshes must not replace streaming output with an older render snapshot.
    const previous = current.current;
    if (
      initial.activeSessionId !== previous.activeSessionId ||
      initial.run?.id !== previous.run?.id ||
      (initial.run?.seq ?? 0) >= (previous.run?.seq ?? 0)
    ) {
      current.current = initial;
      setBlock(initial);
    }
  }, [initial]);
  useEffect(() => {
    const token = ++lifetime.current;
    let release: (() => void) | undefined;
    let disposed = false;
    if (isTauri()) {
      subscription.current = events
        .onPluginEvent((event) => {
          if (
            disposed ||
            event.pluginId !== pluginId ||
            event.event !== "chat" ||
            event.generation < generation.current
          )
            return;
          generation.current = event.generation;
          const value = applyChatEvent(current.current, viewId, event.payload);
          if (value !== current.current) {
            current.current = value;
            setBlock(value);
          }
        })
        .then((unlisten) => {
          if (disposed) unlisten();
          else release = unlisten;
        });
      // Keep a visible, retryable error; never start a stream without its listener.
      void subscription.current.catch((cause) => {
        if (!disposed) {
          setError(translateError(cause));
          setStreamFailed(true);
        }
      });
    }
    return () => {
      disposed = true;
      lifetime.current = token + 1;
      release?.();
    };
  }, [pluginId, viewId, streamAttempt]);
  useEffect(() => {
    if (nearBottom.current && viewport.current)
      viewport.current.scrollTop = viewport.current.scrollHeight;
  }, [block.messages, block.approvals, block.tasks]);

  const active = block.run?.status === "running" || block.run?.status === "waiting";
  const messages = block.messages.filter(
    (message) =>
      message.role !== "assistant" ||
      message.content.trim() ||
      (message.status === "streaming" && active),
  );
  const draft = drafts[block.activeSessionId] ?? "";
  const command = async (
    name: string | undefined,
    input: Record<string, unknown>,
    prepare?: () => void,
  ): Promise<boolean> => {
    if (!name || pending.current) return false;
    pending.current = true;
    const token = lifetime.current;
    setBusy(name);
    setError(null);
    try {
      if (new TextEncoder().encode(JSON.stringify(input)).length > PLUGIN_INPUT_MAX_BYTES)
        throw new Error(t("pluginView.inputTooLarge"));
      if (isTauri() && !(await authorizePluginAction(pluginId))) return false;
      await subscription.current;
      if (lifetime.current !== token) return false;
      prepare?.();
      const result = chatRecord(
        await api.pluginRun(pluginId, name, {
          sessionId: current.current.activeSessionId,
          runId: current.current.run?.id ?? null,
          ...input,
          _locale: i18n.resolvedLanguage ?? i18n.language,
        }),
      );
      if (lifetime.current !== token) return false;
      const next = normalizeChatBlock(result.block ?? (result.type === "chat" ? result : null));
      if (next) {
        const previous = current.current;
        if (
          previous.activeSessionId !== next.activeSessionId ||
          previous.run?.id !== next.run?.id ||
          (next.run?.seq ?? 0) >= (previous.run?.seq ?? 0)
        )
          update(next);
      }
      return true;
    } catch (cause) {
      reportPluginExecutionFailure(cause);
      if (lifetime.current === token) setError(translateError(cause));
      return false;
    } finally {
      if (lifetime.current === token) {
        pending.current = false;
        setBusy(null);
      }
    }
  };
  const send = async () => {
    const message = draft.trim();
    if (!message || active || !block.configured) return;
    if (new TextEncoder().encode(message).length > PLUGIN_INPUT_MAX_BYTES / 2) {
      setError(t("pluginView.inputTooLarge"));
      return;
    }
    const runId = crypto.randomUUID(),
      sessionId = block.activeSessionId;
    let dispatched = false;
    const ok = await command(
      block.commands.send,
      { message, runId, mode: block.mode, modelId: block.modelId },
      () => {
        dispatched = true;
        update((previous) => ({
          ...previous,
          messages: [...previous.messages, { id: `user:${runId}`, role: "user", content: message }],
          run: { id: runId, status: "running", seq: 0 },
          approvals: [],
        }));
        setDrafts((previous) => ({ ...previous, [sessionId]: "" }));
        nearBottom.current = true;
        setAtBottom(true);
      },
    );
    if (!ok && dispatched) {
      update((previous) =>
        previous.run?.id === runId
          ? { ...previous, run: { ...previous.run, status: "failed" } }
          : previous,
      );
      setDrafts((previous) => ({ ...previous, [sessionId]: previous[sessionId] || message }));
    }
  };
  const setMode = (mode: ChatMode) => {
    if (mode === "full" && block.mode !== "full") {
      if (useDialogs.getState().dialog.kind !== "none") return;
      useDialogs.getState().confirm({
        title: t("pluginChat.fullTitle"),
        body: t("pluginChat.fullConfirm"),
        confirmLabel: t("pluginChat.enableFull"),
        danger: true,
        onConfirm: () => update((previous) => ({ ...previous, mode })),
      });
    } else update((previous) => ({ ...previous, mode }));
  };
  const chooseSession = (sessionId: string) => {
    void command(block.commands.session, { action: "select", sessionId });
  };
  return (
    <section className="plugin-chat" aria-label={t("pluginChat.title")}>
      <div className="plugin-chat__toolbar">
        <Select
          label={t("pluginChat.session")}
          value={block.activeSessionId}
          options={
            block.sessions.length
              ? block.sessions.map((item) => ({
                  value: item.id,
                  label: item.title || t("pluginChat.untitled"),
                }))
              : [{ value: block.activeSessionId, label: t("pluginChat.untitled") }]
          }
          disabled={!!busy || !block.commands.session}
          onChange={chooseSession}
        />
        {block.commands.session ? (
          <>
            <IconButton
              label={t("pluginChat.newSession")}
              disabled={!!busy}
              onClick={() => void command(block.commands.session, { action: "new" })}
            >
              <Plus size={14} />
            </IconButton>
            <IconButton
              label={t("pluginChat.deleteSession")}
              disabled={!!busy || active}
              onClick={() => {
                if (useDialogs.getState().dialog.kind !== "none") return;
                useDialogs.getState().confirm({
                  title: t("pluginChat.deleteSession"),
                  body: t("pluginChat.deleteConfirm"),
                  confirmLabel: t("common.delete"),
                  danger: true,
                  onConfirm: () => {
                    void command(block.commands.session, { action: "delete" });
                  },
                });
              }}
            >
              <Trash2 size={13} />
            </IconButton>
          </>
        ) : null}
        {block.commands.configure ? (
          <IconButton
            label={t("pluginChat.configure")}
            disabled={!!busy || active}
            onClick={() => {
              setError(null);
              setConfigOpen(true);
            }}
          >
            <Settings2 size={14} />
          </IconButton>
        ) : null}
      </div>
      <div className="plugin-chat__selectors">
        <Select
          label={t("pluginChat.model")}
          value={block.modelId}
          options={
            block.models.length
              ? block.models.map((item) => ({ value: item.id, label: item.label }))
              : [{ value: "", label: t("pluginChat.chooseProfile") }]
          }
          disabled={!!busy || active}
          onChange={(modelId) => update((previous) => ({ ...previous, modelId }))}
        />
        <Select
          label={t("pluginChat.mode")}
          value={block.mode}
          options={CHAT_MODES.map((mode) => ({
            value: mode,
            label: t(`pluginChat.modes.${mode}`),
          }))}
          disabled={!!busy || active}
          onChange={(mode) => setMode(mode as ChatMode)}
        />
      </div>
      <p className={`plugin-chat__mode-hint${block.mode === "full" ? " is-full" : ""}`}>
        {t(`pluginChat.modeHints.${block.mode}`)}
      </p>
      <div
        className="plugin-chat__messages"
        ref={viewport}
        role="log"
        aria-label={t("pluginChat.messages")}
        aria-live="off"
        onScroll={() => {
          const target = viewport.current!;
          nearBottom.current = target.scrollHeight - target.scrollTop - target.clientHeight < 72;
          setAtBottom(nearBottom.current);
        }}
      >
        {!block.configured ? (
          <div className="plugin-chat__empty">
            <p>{t("pluginChat.setupHint")}</p>
            {block.commands.configure ? (
              <Button size="sm" onClick={() => setConfigOpen(true)}>
                {t("pluginChat.configure")}
              </Button>
            ) : null}
          </div>
        ) : !messages.length ? (
          <p className="plugin-chat__empty">{t("pluginChat.empty")}</p>
        ) : null}
        {messages.map((message) =>
          message.role === "tool" ? (
            <article className="plugin-chat__message is-tool" key={message.id}>
              <details className="plugin-chat__tool-output">
                <summary>{t("pluginChat.toolOutput")}</summary>
                <div className="plugin-chat__message-head">
                  <strong>{t("pluginChat.roles.tool")}</strong>
                  <IconButton
                    size="sm"
                    label={t("pluginChat.copyToolOutput")}
                    onClick={() => void copyText(message.content)}
                  >
                    <Copy size={12} />
                  </IconButton>
                </div>
                <pre tabIndex={0}>{message.content}</pre>
              </details>
            </article>
          ) : (
            <article className={`plugin-chat__message is-${message.role}`} key={message.id}>
              <div className="plugin-chat__message-head">
                <strong>{t(`pluginChat.roles.${message.role}`)}</strong>
                <IconButton
                  size="sm"
                  label={t("pluginChat.copyMessage")}
                  onClick={() => void copyText(message.content)}
                >
                  <Copy size={12} />
                </IconButton>
              </div>
              {message.role === "assistant" ? (
                <PluginMarkdown source={message.content} />
              ) : (
                <div className="plugin-chat__plain">{message.content}</div>
              )}
            </article>
          ),
        )}
        {block.approvals.map((approval) => (
          <article
            className="plugin-chat__approval"
            key={approval.id}
            aria-label={t("pluginChat.approval")}
          >
            <strong>{approval.title || approval.tool}</strong>
            <small>
              {approval.tool}
              {approval.risk ? ` · ${approval.risk}` : ""}
            </small>
            {approval.detail ? <p>{approval.detail}</p> : null}
            {approval.command ? <pre tabIndex={0}>{approval.command}</pre> : null}
            <div className="plugin-chat__actions">
              <Button
                size="sm"
                disabled={!!busy || !block.commands.approve}
                onClick={() =>
                  void command(block.commands.approve, { requestId: approval.id, decision: "deny" })
                }
              >
                {t("pluginChat.deny")}
              </Button>
              <Button
                size="sm"
                variant="primary"
                disabled={!!busy || !block.commands.approve}
                onClick={() =>
                  void command(block.commands.approve, {
                    requestId: approval.id,
                    decision: "allow",
                  })
                }
              >
                {t("pluginChat.allowOnce")}
              </Button>
            </div>
          </article>
        ))}
        {block.tasks.length ? (
          <section className="plugin-chat__tasks" aria-label={t("pluginChat.tasks")}>
            <h4>{t("pluginChat.tasks")}</h4>
            {block.tasks.map((task) => (
              <article key={task.id} className="plugin-chat__task">
                <div className="plugin-chat__task-head">
                  <strong>{task.title || task.id}</strong>
                  <span>{t(`pluginChat.taskStates.${task.status}`)}</span>
                </div>
                {task.output ? (
                  <details>
                    <summary>{t("pluginChat.taskOutput")}</summary>
                    <pre tabIndex={0}>{task.output}</pre>
                  </details>
                ) : null}
                {task.recoverable && block.commands.recover ? (
                  <div className="plugin-chat__actions">
                    <span className="settings-hint">{t("pluginChat.recoveryHint")}</span>
                    <Button
                      size="sm"
                      disabled={!!busy || active}
                      onClick={() =>
                        void command(block.commands.recover, { taskId: task.id, action: "inspect" })
                      }
                    >
                      {t("pluginChat.inspectTask")}
                    </Button>
                    <Button
                      size="sm"
                      disabled={!!busy || active}
                      onClick={() =>
                        void command(block.commands.recover, { taskId: task.id, action: "resume" })
                      }
                    >
                      {t("pluginChat.resumeTask")}
                    </Button>
                  </div>
                ) : null}
              </article>
            ))}
          </section>
        ) : null}
        {block.run?.status === "interrupted" && block.commands.recover ? (
          <article className="plugin-chat__task">
            <strong>{t("pluginChat.taskStates.interrupted")}</strong>
            <p className="settings-hint">{t("pluginChat.recoveryHint")}</p>
            <Button
              size="sm"
              disabled={!!busy}
              onClick={() => void command(block.commands.recover, { action: "resume" })}
            >
              {t("pluginChat.resumeTask")}
            </Button>
          </article>
        ) : null}
      </div>
      {!atBottom ? (
        <Button
          size="sm"
          variant="ghost"
          leading={<ArrowDown size={12} />}
          onClick={() => {
            nearBottom.current = true;
            setAtBottom(true);
            if (viewport.current) viewport.current.scrollTop = viewport.current.scrollHeight;
          }}
        >
          {t("pluginChat.latest")}
        </Button>
      ) : null}
      {block.notice ? (
        <p className="plugin-chat__notice" role="status">
          {block.notice}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="panel__error">
          {error}
        </p>
      ) : null}
      {streamFailed ? (
        <Button
          size="sm"
          disabled={!!busy}
          onClick={() => {
            setError(null);
            setStreamFailed(false);
            setStreamAttempt((attempt) => attempt + 1);
          }}
        >
          {t("common.retry")}
        </Button>
      ) : null}
      <form
        className="plugin-chat__composer"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <label className="sr-only" htmlFor={inputId}>
          {t("pluginChat.message")}
        </label>
        <Textarea
          id={inputId}
          aria-label={t("pluginChat.message")}
          placeholder={t("pluginChat.placeholder")}
          value={draft}
          rows={3}
          disabled={!block.configured}
          onChange={(event) =>
            setDrafts((previous) => ({ ...previous, [block.activeSessionId]: event.target.value }))
          }
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              if (!active && !busy) void send();
            }
          }}
        />
        <div className="plugin-chat__composer-foot">
          <span role="status" aria-live="polite">
            {active
              ? t(block.run?.status === "waiting" ? "pluginChat.waiting" : "pluginChat.streaming")
              : t("pluginChat.enterHint")}
          </span>
          {active ? (
            <Button
              size="sm"
              disabled={!!busy}
              leading={<Square size={12} />}
              onClick={() => void command(block.commands.stop, {})}
            >
              {t("pluginChat.stop")}
            </Button>
          ) : (
            <Button
              size="sm"
              type="submit"
              variant="primary"
              disabled={!!busy || !draft.trim() || !block.configured}
              leading={<Send size={12} />}
            >
              {t("pluginChat.send")}
            </Button>
          )}
        </div>
      </form>
      {configOpen && !appDialogOpen ? (
        <PluginChatConfigDialog
          config={block.config}
          busy={!!busy}
          error={error}
          onClose={() => {
            setConfigOpen(false);
            setError(null);
          }}
          onSave={(config) => command(block.commands.configure, { config })}
        />
      ) : null}
    </section>
  );
}
