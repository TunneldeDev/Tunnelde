import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowDown,
  Asterisk,
  CheckCheck,
  ChevronDown,
  CircleHelp,
  Code2,
  History,
  Laptop,
  Plus,
  Send,
  Server,
  Settings2,
  ShieldCheck,
  ShieldOff,
  Sparkles,
  Square,
  Terminal,
} from "lucide-react";
import { Button, IconButton } from "@/components/ui/form/Button";
import { Textarea } from "@/components/ui/form/Field";
import { Menu } from "@/components/ui/overlay/Menu";
import { api, events, isTauri } from "@/lib/api/ipc";
import { translateError } from "@/lib/api/errors";
import {
  CHAT_MODES,
  applyChatEvent,
  chatRecord,
  chatSessionTitle,
  chatExecutionKey,
  normalizeChatBlock,
  type PluginChatBlock,
} from "@/lib/plugins/pluginChat";
import { PLUGIN_INPUT_MAX_BYTES } from "@/lib/plugins/pluginView";
import { authorizePluginAction, reportPluginExecutionFailure } from "@/store/pluginSecurity";
import { useDialogs } from "@/store/dialogs";
import { useSsh } from "@/store/ssh";
import { useHosts } from "@/store/hosts";
import { chatTargets } from "@/lib/plugins/chatTargets";
import { PluginChatMessages } from "./PluginChatMessages";
import { PluginChatConfigDialog } from "./PluginChatConfig";
import { PluginExecutionDialog } from "./PluginExecutionDialog";
import { PluginChatSessions } from "./PluginChatSessions";
import "@/styles/pluginChat.css";
import { useViewState, useBackgroundGuard } from "@/lib/session/viewState";

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
  const [drafts, setDrafts] = useViewState<Record<string, string>>(
    `chat:${pluginId}:${viewId}:${initial.id}`,
    {},
  );
  const [busy, setBusy] = useState<string | null>(null);
  const pending = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [streamFailed, setStreamFailed] = useState(false);
  const [streamAttempt, setStreamAttempt] = useState(0);
  const [configOpen, setConfigOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [executionOpen, setExecutionOpen] = useState<string | null>(null);
  useBackgroundGuard(busy !== null || configOpen || executionOpen !== null || historyOpen);
  const sshSessions = useSsh((state) => state.sessions);
  const hosts = useHosts((state) => state.hosts);
  const [atBottom, setAtBottom] = useState(true);
  const viewport = useRef<HTMLDivElement>(null);
  const nearBottom = useRef(true);
  const visibleSession = useRef(initial.activeSessionId);
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
    if (visibleSession.current !== block.activeSessionId) {
      visibleSession.current = block.activeSessionId;
      nearBottom.current = true;
      setAtBottom(true);
    }
    if (nearBottom.current && viewport.current)
      viewport.current.scrollTop = viewport.current.scrollHeight;
  }, [block.activeSessionId, block.messages, block.approvals, block.tasks]);

  const active = block.run?.status === "running" || block.run?.status === "waiting";
  const preparing = block.readiness?.status === "checking";
  useEffect(() => {
    if (!preparing || !isTauri()) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const result = chatRecord(
          await api.pluginRenderView(pluginId, viewId, i18n.resolvedLanguage ?? i18n.language),
        );
        const candidate = Array.isArray(result.blocks)
          ? result.blocks.find((item) => chatRecord(item).id === current.current.id)
          : null;
        const next = normalizeChatBlock(candidate);
        const previous = current.current;
        if (
          !disposed &&
          previous.readiness?.status === "checking" &&
          next &&
          next.activeSessionId === previous.activeSessionId &&
          next.modelId === previous.modelId &&
          next.execution?.kind === previous.execution?.kind &&
          next.execution?.sessionId === previous.execution?.sessionId &&
          next.execution?.hostId === previous.execution?.hostId &&
          next.execution?.cwd === previous.execution?.cwd
        ) {
          current.current = next;
          setBlock(next);
        }
      } catch {
        // The event stream remains primary; a temporary refresh error is retryable.
      } finally {
        if (!disposed) timer = setTimeout(() => void refresh(), 2000);
      }
    };
    // Read-only fallback for a missing final snapshot; never launches an agent.
    timer = setTimeout(() => void refresh(), 2000);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [preparing, pluginId, viewId, i18n.resolvedLanguage, i18n.language]);
  const messages = block.messages.filter(
    (message) =>
      message.role !== "assistant" ||
      message.content.trim() ||
      !!message.activity?.length ||
      (message.status === "streaming" && active),
  );
  const draft = drafts[block.activeSessionId] ?? "";
  const title = block.title || t("pluginChat.title");
  const primaryProtocol =
    block.profilePolicy?.primaryProtocols.length === 1
      ? block.profilePolicy.primaryProtocols[0]
      : null;
  const presentation =
    primaryProtocol === "claude-code"
      ? "claude"
      : primaryProtocol === "codex"
        ? "codex"
        : primaryProtocol === "pi"
          ? "pi"
          : "copilot";
  const BrandIcon =
    presentation === "claude"
      ? Asterisk
      : presentation === "codex"
        ? Code2
        : presentation === "pi"
          ? Terminal
          : Sparkles;
  const configureLabel = block.title
    ? t("pluginChat.configureNamed", { name: block.title })
    : t("pluginChat.configure");
  const profile =
    block.config?.profiles.find((item) => item.id === block.modelId) ??
    block.config?.profiles.find((item) => item.id === block.config?.activeProfileId);
  const agentReady =
    !block.commands.prepare ||
    (block.readiness?.status === "ready" &&
      block.readiness.profileId === block.modelId &&
      block.readiness.targetKey === chatExecutionKey(block.execution));
  const executionProfiles =
    block.config?.profiles.filter(
      (item) =>
        !block.profilePolicy || block.profilePolicy.primaryProtocols.includes(item.protocol),
    ) ?? [];
  const unsupportedReadOnly = (protocol: string | undefined) =>
    protocol === "claude-code" || protocol === "pi";
  const readOnlyUnavailable =
    block.mode === "readOnly" &&
    unsupportedReadOnly(profile?.protocol || primaryProtocol || undefined);
  const remoteSession =
    block.execution?.kind === "remote"
      ? block.execution.sessionId
      : block.execution?.kind === "local"
        ? undefined
        : profile?.remote?.sessionId || profile?.sessionId;
  const targets = chatTargets(sshSessions, hosts, remoteSession);
  const liveTarget = targets.find((item) => item.id === remoteSession);
  const location = remoteSession
    ? liveTarget?.title || block.execution?.title || t("pluginChat.remoteExecution")
    : t("pluginChat.localExecution");
  const locationDetail =
    block.execution?.cwd ||
    (remoteSession
      ? [remoteSession, profile?.remote?.directory || profile?.cwd].filter(Boolean).join(" · ")
      : profile?.cwd);
  const modeIcons = {
    ask: <CircleHelp size={13} />,
    approve: <CheckCheck size={13} />,
    full: <ShieldOff size={13} />,
    readOnly: <ShieldCheck size={13} />,
  };
  const openConfig = () => {
    setError(null);
    setConfigOpen(true);
  };
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
          ...(name === current.current.commands.target ? { mode: current.current.mode } : {}),
          ...input,
          _locale: i18n.resolvedLanguage ?? i18n.language,
        }),
      );
      if (lifetime.current !== token) return false;
      const next = normalizeChatBlock(result.block ?? (result.type === "chat" ? result : null));
      if (next) {
        const previous = current.current;
        if (
          name === previous.commands.target &&
          previous.activeSessionId !== next.activeSessionId
        ) {
          setDrafts((saved) => ({
            ...saved,
            [next.activeSessionId]: saved[previous.activeSessionId] || "",
          }));
        }
        if (
          previous.activeSessionId !== next.activeSessionId ||
          previous.run?.id !== next.run?.id ||
          (next.run?.seq ?? 0) >= (previous.run?.seq ?? 0)
        )
          update(
            name === previous.commands.session &&
              ["rename", "delete"].includes(String(input.action)) &&
              previous.activeSessionId === next.activeSessionId
              ? { ...next, modelId: previous.modelId, mode: previous.mode }
              : next,
          );
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
    if (!message || active || preparing || !agentReady || !block.configured || readOnlyUnavailable)
      return;
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
  const setMode = (mode: typeof block.mode) => {
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
  const modelPicker = (
    <Menu
      label={t("pluginChat.model")}
      className="plugin-chat__model"
      menuClassName="plugin-chat__model-menu"
      disabled={!!busy || active || preparing || !block.models.length}
      trigger={
        <>
          <Sparkles size={13} aria-hidden="true" />
          <span className="plugin-chat__control-label">
            {block.models.find((item) => item.id === block.modelId)?.label ||
              t("pluginChat.chooseProfile")}
          </span>
          <ChevronDown size={11} aria-hidden="true" />
        </>
      }
      items={block.models.map((item) => ({
        label: item.label,
        checked: item.id === block.modelId,
        disabled:
          block.mode === "readOnly" &&
          unsupportedReadOnly(
            block.config?.profiles.find((entry) => entry.id === item.id)?.protocol,
          ),
        onSelect: () => update((previous) => ({ ...previous, modelId: item.id })),
      }))}
    />
  );
  const permissionPicker = (
    <Menu
      label={t("pluginChat.mode")}
      className={`plugin-chat__mode${block.mode === "full" ? " is-full" : ""}`}
      menuClassName="plugin-chat__permissions-menu"
      disabled={!!busy || active || preparing}
      trigger={
        <>
          {modeIcons[block.mode]}
          <span className="plugin-chat__control-label">{t(`pluginChat.modes.${block.mode}`)}</span>
          <ChevronDown size={11} aria-hidden="true" />
        </>
      }
      items={CHAT_MODES.map((mode) => ({
        label: t(`pluginChat.modes.${mode}`),
        description:
          mode === "readOnly" &&
          unsupportedReadOnly(profile?.protocol || primaryProtocol || undefined)
            ? t("pluginChat.readOnlyUnavailable")
            : t(`pluginChat.modeHints.${mode}`),
        disabled:
          mode === "readOnly" &&
          unsupportedReadOnly(profile?.protocol || primaryProtocol || undefined),
        checked: mode === block.mode,
        icon: modeIcons[mode],
        onSelect: () => setMode(mode),
      }))}
    />
  );
  const locationControl = (
    <Menu
      className="plugin-chat__location"
      menuClassName="plugin-chat__location-menu"
      label={t("pluginChat.executionLocation")}
      disabled={
        !!busy || active || preparing || (!executionProfiles.length && !block.commands.configure)
      }
      trigger={
        <>
          {remoteSession ? <Server size={13} /> : <Laptop size={13} />}
          <span className="plugin-chat__control-label">{location}</span>
          <ChevronDown size={11} aria-hidden="true" />
        </>
      }
      items={[
        ...(block.commands.target
          ? [
              {
                label: t("pluginChat.localExecution"),
                icon: <Laptop size={13} />,
                checked: !remoteSession,
                onSelect: () => {
                  if (block.execution?.kind === "local") return;
                  void command(block.commands.target, {
                    targetId: "local",
                    modelId: block.modelId,
                  });
                },
              },
              ...targets.map((item) => ({
                label: item.title || item.address,
                description: item.address,
                icon: <Server size={13} />,
                checked: remoteSession === item.id,
                onSelect: () => {
                  if (remoteSession === item.id) return;
                  void command(block.commands.target, {
                    targetId: item.id,
                    modelId: block.modelId,
                  });
                },
              })),
              ...(!sshSessions.length
                ? [{ label: t("pluginChat.connectTargetHint"), disabled: true, onSelect: () => {} }]
                : []),
              {
                label: t("pluginChat.executionSettings"),
                separatorBefore: true,
                icon: <Settings2 size={13} />,
                onSelect: () => setExecutionOpen(remoteSession || "local"),
              },
            ]
          : executionProfiles.map((item) => {
              const remote = item.remote?.sessionId || item.sessionId;
              return {
                label: `${t(remote ? "pluginChat.remoteExecution" : "pluginChat.localExecution")} · ${item.name || item.model || item.id}`,
                description: remote
                  ? [remote, item.remote?.directory || item.cwd].filter(Boolean).join(" · ")
                  : item.cwd || undefined,
                checked: item.id === block.modelId,
                disabled: block.mode === "readOnly" && unsupportedReadOnly(item.protocol),
                icon: remote ? <Server size={13} /> : <Laptop size={13} />,
                onSelect: () => update((previous) => ({ ...previous, modelId: item.id })),
              };
            })),
        ...(!block.commands.target && !executionProfiles.length && block.commands.configure
          ? [
              {
                label: configureLabel,
                icon: <Settings2 size={13} />,
                separatorBefore: !!block.commands.target || executionProfiles.length > 0,
                onSelect: openConfig,
              },
            ]
          : []),
      ]}
    />
  );
  return (
    <section className={`plugin-chat plugin-chat--${presentation}`} aria-label={title}>
      {executionOpen ? (
        <PluginExecutionDialog
          targetId={executionOpen}
          targetName={
            targets.find((item) => item.id === executionOpen)?.title ||
            (executionOpen !== "local" ? block.execution?.title : null) ||
            (executionOpen !== "local" ? t("pluginChat.remoteExecution") : null) ||
            t("pluginChat.localExecution")
          }
          execution={
            block.execution?.sessionId === executionOpen ||
            (executionOpen === "local" && block.execution?.kind === "local")
              ? block.execution
              : undefined
          }
          apiAssistant={presentation === "copilot"}
          busy={!!busy}
          error={error}
          onClose={() => setExecutionOpen(null)}
          onSave={async (input) => {
            const ok = await command(block.commands.target, {
              ...input,
              targetId: executionOpen,
              modelId: block.modelId,
            });
            if (ok) setExecutionOpen(null);
          }}
        />
      ) : null}
      {presentation === "claude" || presentation === "pi" ? (
        <div className="plugin-chat__brand-header">
          <BrandIcon size={18} aria-hidden="true" />
          <strong>{title}</strong>
        </div>
      ) : null}
      <div className="plugin-chat__toolbar">
        <button
          type="button"
          className="plugin-chat__session"
          aria-label={t("pluginChat.session")}
          aria-haspopup="dialog"
          aria-expanded={historyOpen}
          title={t("pluginChat.sessionHistory")}
          disabled={!!busy || !block.commands.session}
          onClick={() => {
            setError(null);
            setHistoryOpen(true);
          }}
        >
          <History size={14} aria-hidden="true" />
          <span>
            {chatSessionTitle(
              block.sessions.find((item) => item.id === block.activeSessionId),
              t("pluginChat.untitled"),
            )}
          </span>
          <ChevronDown size={12} aria-hidden="true" />
        </button>
        {block.commands.session ? (
          <>
            <IconButton
              label={t("pluginChat.newSession")}
              disabled={!!busy}
              onClick={() => void command(block.commands.session, { action: "new" })}
            >
              <Plus size={14} />
            </IconButton>
          </>
        ) : null}
        {block.commands.configure ? (
          <IconButton
            label={configureLabel}
            disabled={!!busy || active || preparing}
            onClick={openConfig}
          >
            <Settings2 size={14} />
          </IconButton>
        ) : null}
      </div>
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
        {presentation === "codex" &&
        !messages.length &&
        block.commands.session &&
        block.sessions.some((item) => item.id !== block.activeSessionId) ? (
          <section className="plugin-chat__recents" aria-label={t("pluginChat.recentSessions")}>
            <h3>{t("pluginChat.recentSessions")}</h3>
            {block.sessions
              .filter((item) => item.id !== block.activeSessionId)
              .slice(0, 3)
              .map((item) => (
                <button
                  type="button"
                  key={item.id}
                  disabled={!!busy || active || preparing}
                  onClick={() => chooseSession(item.id)}
                >
                  <History size={13} aria-hidden="true" />
                  <span>{chatSessionTitle(item, t("pluginChat.untitled"))}</span>
                </button>
              ))}
          </section>
        ) : null}
        {!messages.length && !block.approvals.length && !block.tasks.length ? (
          <div className="plugin-chat__empty">
            <span className="plugin-chat__brand-mark" aria-hidden="true">
              <BrandIcon size={32} strokeWidth={1.5} />
            </span>
            <h2>{title}</h2>
            <p>
              {block.configured
                ? t("pluginChat.emptyPrompt")
                : presentation !== "copilot"
                  ? t("pluginChat.setupNamed", { name: title })
                  : t("pluginChat.setupHint")}
            </p>
            {!block.configured && block.commands.configure ? (
              <Button size="sm" onClick={openConfig}>
                {configureLabel}
              </Button>
            ) : null}
          </div>
        ) : null}
        <PluginChatMessages messages={messages} title={title} active={active} />
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
                      disabled={!!busy || active || preparing}
                      onClick={() =>
                        void command(block.commands.recover, { taskId: task.id, action: "inspect" })
                      }
                    >
                      {t("pluginChat.inspectTask")}
                    </Button>
                    <Button
                      size="sm"
                      disabled={!!busy || active || preparing}
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
          className="plugin-chat__latest"
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
      {block.notice || readOnlyUnavailable ? (
        <p className="plugin-chat__notice" role="status">
          {readOnlyUnavailable ? t("pluginChat.readOnlyUnavailable") : block.notice}
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
      {block.commands.prepare && !agentReady && !active ? (
        <section
          className="plugin-chat__initialization"
          aria-label={t("pluginChat.initialization")}
        >
          <p role={block.readiness?.status === "error" ? "alert" : "status"}>
            {preparing
              ? t("pluginChat.initializing")
              : t("pluginChat.initializeHint", { location })}
          </p>
          {block.readiness?.status === "error" && block.readiness.detail ? (
            <small>{block.readiness.detail}</small>
          ) : null}
          {remoteSession && block.commands.install ? (
            <Button
              size="sm"
              disabled={!!busy || preparing || !block.configured}
              onClick={() => void command(block.commands.install, { modelId: block.modelId })}
            >
              {t("pluginChat.installInitialize")}
            </Button>
          ) : null}
        </section>
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
        {presentation === "codex" ? (
          <div className="plugin-chat__location-bar">
            {locationControl}
            <span title={locationDetail}>{locationDetail}</span>
          </div>
        ) : null}
        <div className="plugin-chat__input-card">
          <Textarea
            id={inputId}
            aria-label={t("pluginChat.message")}
            placeholder={
              block.title
                ? t("pluginChat.placeholderNamed", { name: block.title })
                : t("pluginChat.placeholder")
            }
            value={draft}
            rows={3}
            disabled={!block.configured}
            onChange={(event) =>
              setDrafts((previous) => ({
                ...previous,
                [block.activeSessionId]: event.target.value,
              }))
            }
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                if (!active && !busy) void send();
              }
            }}
          />
          <div className="plugin-chat__composer-foot">
            {presentation === "codex" ? permissionPicker : modelPicker}
            {presentation === "copilot" || presentation === "pi" ? locationControl : null}
            {presentation === "claude" ? permissionPicker : null}
            {presentation === "codex" ? modelPicker : null}
            {active || preparing ? (
              <IconButton
                className="plugin-chat__send is-stopping"
                label={preparing ? t("pluginChat.cancelInitialization") : t("pluginChat.stop")}
                disabled={!!busy}
                onClick={() => void command(block.commands.stop, {})}
              >
                <Square size={13} fill="currentColor" />
              </IconButton>
            ) : !block.configured || !agentReady ? (
              <Button
                className="plugin-chat__initialize"
                size="sm"
                disabled={!!busy || preparing}
                onClick={() => {
                  if (!block.configured) openConfig();
                  else void command(block.commands.prepare, { modelId: block.modelId });
                }}
              >
                {preparing
                  ? t("pluginChat.initializing")
                  : block.configured
                    ? t("pluginChat.initialize")
                    : t("pluginChat.configure")}
              </Button>
            ) : (
              <IconButton
                className="plugin-chat__send"
                label={t("pluginChat.send")}
                type="submit"
                disabled={!!busy || !draft.trim() || !block.configured || readOnlyUnavailable}
              >
                <Send size={14} />
              </IconButton>
            )}
          </div>
        </div>
        <div className="plugin-chat__composer-meta">
          {presentation === "copilot" || presentation === "pi" ? (
            <>
              <span className="plugin-chat__identity" title={title}>
                <BrandIcon size={12} aria-hidden="true" />
                <span>{title}</span>
              </span>
              <span className="plugin-chat__meta-divider" aria-hidden="true" />
              {permissionPicker}
            </>
          ) : null}
          {presentation === "claude" ? locationControl : null}
          <span className="sr-only" role="status" aria-live="polite">
            {active
              ? t(block.run?.status === "waiting" ? "pluginChat.waiting" : "pluginChat.streaming")
              : t("pluginChat.enterHint")}
          </span>
        </div>
      </form>
      {historyOpen ? (
        <PluginChatSessions
          sessions={block.sessions}
          activeId={block.activeSessionId}
          activeRunning={active || preparing}
          suspended={appDialogOpen}
          busy={!!busy}
          error={error}
          onClose={() => setHistoryOpen(false)}
          onAction={(action, sessionId, title) =>
            command(block.commands.session, {
              action,
              sessionId,
              ...(title !== undefined ? { title } : {}),
            })
          }
        />
      ) : null}
      {configOpen && !appDialogOpen ? (
        <PluginChatConfigDialog
          config={block.config}
          title={block.title}
          profilePolicy={block.profilePolicy}
          managedTargets={!!block.commands.target}
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
