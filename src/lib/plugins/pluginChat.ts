export const CHAT_MODES = ["ask", "approve", "full", "readOnly"] as const;
export type ChatMode = (typeof CHAT_MODES)[number];
export const CHAT_PROTOCOLS = [
  "openai-chat",
  "openai-responses",
  "anthropic",
  "gemini",
  "codex",
  "claude-code",
  "pi",
] as const;
export type ChatProtocol = (typeof CHAT_PROTOCOLS)[number];
export interface ChatProfilePolicy {
  primaryProtocols: ChatProtocol[];
  reviewerProtocols: ChatProtocol[];
  defaultProtocol: ChatProtocol;
}
export interface ChatProfile {
  id: string;
  name: string;
  protocol: ChatProtocol;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  executable: string;
  cwd: string;
  sessionId: string;
  platform?: "posix" | "windows";
  provider?: string;
  helperBinary?: string;
  remote?: {
    sessionId: string;
    platform: "posix" | "windows";
    directory: string;
    runnerPath: string;
    executable: string;
  };
}
export interface PluginChatConfig {
  profiles: ChatProfile[];
  activeProfileId: string;
  approverProfileId: string;
  mode: ChatMode;
  scope: {
    localRoots: string[];
    sessionIds: string[];
    remoteRoots: { sessionId: string; path: string }[];
  };
}
export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  status?: string;
}
export interface ChatApproval {
  id: string;
  tool: string;
  title: string;
  detail: string;
  command: string;
  risk: string;
}
export interface ChatTask {
  id: string;
  title: string;
  status: "queued" | "running" | "done" | "failed" | "cancelled" | "interrupted";
  output: string;
  recoverable: boolean;
}
export interface PluginChatBlock {
  type: "chat";
  id: string;
  title?: string;
  profilePolicy?: ChatProfilePolicy;
  commands: {
    send: string;
    stop: string;
    configure?: string;
    session?: string;
    approve?: string;
    recover?: string;
  };
  sessions: { id: string; title: string }[];
  activeSessionId: string;
  mode: ChatMode;
  models: { id: string; label: string }[];
  modelId: string;
  messages: ChatMessage[];
  run: {
    id: string;
    status: "idle" | "running" | "waiting" | "done" | "cancelled" | "failed" | "interrupted";
    seq: number;
  } | null;
  approvals: ChatApproval[];
  tasks: ChatTask[];
  configured: boolean;
  notice: string;
  config?: PluginChatConfig;
}

export function chatRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown, limit = 4000) =>
  typeof value === "string" ? value.slice(0, limit) : "";
const id = (value: unknown) =>
  typeof value === "string" &&
  /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value) &&
  ![...Object.getOwnPropertyNames(Object.prototype), "prototype"].includes(value)
    ? value
    : "";
const strings = (value: unknown) =>
  list(value)
    .slice(0, 100)
    .map((item) => text(item))
    .filter(Boolean);

export function normalizeChatConfig(value: unknown): PluginChatConfig | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = chatRecord(value),
    scope = chatRecord(raw.scope);
  return {
    profiles: list(raw.profiles)
      .slice(0, 30)
      .flatMap((item) => {
        const profile = chatRecord(item),
          protocol = text(profile.protocol) as ChatProtocol;
        return id(profile.id) && CHAT_PROTOCOLS.includes(protocol)
          ? [
              {
                id: id(profile.id),
                name: text(profile.name),
                protocol,
                baseUrl: text(profile.baseUrl),
                model: text(profile.model),
                hasApiKey: profile.hasApiKey === true,
                executable: text(profile.executable),
                cwd: text(profile.cwd),
                sessionId: text(profile.sessionId),
                ...(profile.platform === "windows" || profile.platform === "posix"
                  ? { platform: profile.platform }
                  : {}),
                ...(typeof profile.provider === "string"
                  ? { provider: text(profile.provider) }
                  : {}),
                ...(typeof profile.helperBinary === "string"
                  ? { helperBinary: text(profile.helperBinary) }
                  : {}),
                ...(profile.remote && typeof profile.remote === "object"
                  ? {
                      remote: {
                        sessionId: text(chatRecord(profile.remote).sessionId),
                        platform:
                          chatRecord(profile.remote).platform === "windows"
                            ? ("windows" as const)
                            : ("posix" as const),
                        directory: text(chatRecord(profile.remote).directory),
                        runnerPath: text(chatRecord(profile.remote).runnerPath),
                        executable: text(chatRecord(profile.remote).executable),
                      },
                    }
                  : {}),
              },
            ]
          : [];
      }),
    activeProfileId: id(raw.activeProfileId),
    approverProfileId: id(raw.approverProfileId),
    mode: CHAT_MODES.includes(raw.mode as ChatMode) ? (raw.mode as ChatMode) : "ask",
    scope: {
      localRoots: strings(scope.localRoots),
      sessionIds: strings(scope.sessionIds),
      remoteRoots: list(scope.remoteRoots)
        .slice(0, 100)
        .flatMap((item) => {
          const root = chatRecord(item);
          return text(root.sessionId) && text(root.path)
            ? [{ sessionId: text(root.sessionId), path: text(root.path) }]
            : [];
        }),
    },
  };
}

export function normalizeChatBlock(value: unknown): PluginChatBlock | null {
  const raw = chatRecord(value),
    commands = chatRecord(raw.commands);
  if (raw.type !== "chat" || !id(raw.id) || !id(commands.send) || !id(commands.stop)) return null;
  let profilePolicy: ChatProfilePolicy | undefined;
  if (raw.profilePolicy !== undefined) {
    const policy = chatRecord(raw.profilePolicy);
    const protocols = (value: unknown) =>
      Array.isArray(value) &&
      value.length <= CHAT_PROTOCOLS.length &&
      value.every((protocol) => CHAT_PROTOCOLS.includes(protocol as ChatProtocol));
    if (
      !protocols(policy.primaryProtocols) ||
      !(policy.primaryProtocols as ChatProtocol[]).length ||
      !protocols(policy.reviewerProtocols) ||
      !(policy.primaryProtocols as ChatProtocol[]).includes(policy.defaultProtocol as ChatProtocol)
    )
      return null;
    profilePolicy = {
      primaryProtocols: [...new Set(policy.primaryProtocols as ChatProtocol[])],
      reviewerProtocols: [...new Set(policy.reviewerProtocols as ChatProtocol[])],
      defaultProtocol: policy.defaultProtocol as ChatProtocol,
    };
  }
  const run = chatRecord(raw.run);
  const status = text(run.status) as NonNullable<PluginChatBlock["run"]>["status"];
  const mode = text(raw.mode) as ChatMode;
  const unique = <T extends { id: string }>(items: T[]) => [
    ...new Map(items.map((item) => [item.id, item])).values(),
  ];
  return {
    type: "chat",
    id: id(raw.id),
    ...(text(raw.title, 80) ? { title: text(raw.title, 80) } : {}),
    ...(profilePolicy ? { profilePolicy } : {}),
    commands: {
      send: id(commands.send),
      stop: id(commands.stop),
      ...Object.fromEntries(
        ["configure", "session", "approve", "recover"].flatMap((key) =>
          id(commands[key]) ? [[key, id(commands[key])]] : [],
        ),
      ),
    },
    sessions: unique(
      list(raw.sessions)
        .slice(0, 200)
        .flatMap((item) => {
          const session = chatRecord(item);
          return id(session.id) ? [{ id: id(session.id), title: text(session.title) }] : [];
        }),
    ),
    activeSessionId: id(raw.activeSessionId),
    mode: CHAT_MODES.includes(mode) ? mode : "ask",
    models: unique(
      list(raw.models)
        .slice(0, 100)
        .flatMap((item) => {
          const model = chatRecord(item);
          return id(model.id) ? [{ id: id(model.id), label: text(model.label) }] : [];
        }),
    ),
    modelId: id(raw.modelId),
    messages: unique(
      list(raw.messages)
        .slice(-500)
        .flatMap((item) => {
          const message = chatRecord(item),
            role = text(message.role) as ChatMessage["role"];
          return id(message.id) && ["user", "assistant", "system", "tool"].includes(role)
            ? [
                {
                  id: id(message.id),
                  role,
                  content: text(message.content, 262144),
                  status: text(message.status),
                },
              ]
            : [];
        }),
    ),
    run:
      id(run.id) &&
      ["idle", "running", "waiting", "done", "cancelled", "failed", "interrupted"].includes(status)
        ? {
            id: id(run.id),
            status,
            seq: Number.isSafeInteger(run.seq) && Number(run.seq) >= 0 ? Number(run.seq) : 0,
          }
        : null,
    approvals: unique(
      list(raw.approvals)
        .slice(0, 50)
        .flatMap((item) => {
          const approval = chatRecord(item);
          return id(approval.id)
            ? [
                {
                  id: id(approval.id),
                  tool: text(approval.tool),
                  title: text(approval.title),
                  detail: text(approval.detail, 16384),
                  command: text(approval.command, 16384),
                  risk: text(approval.risk),
                },
              ]
            : [];
        }),
    ),
    tasks: unique(
      list(raw.tasks)
        .slice(-100)
        .flatMap((item) => {
          const task = chatRecord(item),
            taskStatus = text(task.status) as ChatTask["status"];
          return id(task.id) &&
            ["queued", "running", "done", "failed", "cancelled", "interrupted"].includes(taskStatus)
            ? [
                {
                  id: id(task.id),
                  title: text(task.title),
                  status: taskStatus,
                  output: text(task.output, 65536),
                  recoverable: task.recoverable === true,
                },
              ]
            : [];
        }),
    ),
    configured: raw.configured === true,
    notice: text(raw.notice),
    config: normalizeChatConfig(raw.config),
  };
}

/** The stream is scoped to one view/session/run; stale or repeated packets cannot replace newer output. */
export function applyChatEvent(
  block: PluginChatBlock,
  viewId: string,
  payload: unknown,
): PluginChatBlock {
  const event = chatRecord(payload);
  if (
    event.viewId !== viewId ||
    event.sessionId !== block.activeSessionId ||
    !Number.isSafeInteger(event.seq) ||
    Number(event.seq) < 0
  )
    return block;
  if (block.run && (event.runId !== block.run.id || Number(event.seq) <= block.run.seq))
    return block;
  if (!block.run && event.type !== "snapshot") return block;
  const seq = Number(event.seq);
  if (event.type === "snapshot") {
    const snapshot = normalizeChatBlock(event.block);
    return snapshot &&
      snapshot.activeSessionId === block.activeSessionId &&
      (!block.run || snapshot.run?.id === block.run.id)
      ? { ...snapshot, run: snapshot.run ? { ...snapshot.run, seq } : null }
      : block;
  }
  const run = block.run!;
  if (event.type === "delta" && id(event.messageId) && typeof event.delta === "string") {
    const messageId = id(event.messageId),
      previous = block.messages.find((message) => message.id === messageId);
    if (previous && previous.role !== "assistant") return block;
    const content = `${previous?.content ?? ""}${event.delta.slice(0, 262144)}`.slice(0, 1048576);
    const message: ChatMessage = { id: messageId, role: "assistant", content };
    return {
      ...block,
      run: { ...run, seq },
      messages: previous
        ? block.messages.map((item) => (item.id === messageId ? message : item))
        : [...block.messages.slice(-499), message],
    };
  }
  if (event.type === "approval") {
    const normalized = normalizeChatBlock({ ...block, approvals: [event.approval] })!;
    const approval = normalized.approvals[0];
    return approval
      ? {
          ...block,
          run: { ...run, status: "waiting", seq },
          approvals: [...block.approvals.filter((item) => item.id !== approval.id), approval],
        }
      : block;
  }
  if (event.type === "task") {
    const normalized = normalizeChatBlock({ ...block, tasks: [event.task] })!;
    const task = normalized.tasks[0];
    return task
      ? {
          ...block,
          run: { ...run, seq },
          tasks: [...block.tasks.filter((item) => item.id !== task.id), task].slice(-100),
        }
      : block;
  }
  if (event.type === "done")
    return {
      ...block,
      run: { ...run, status: event.status === "cancelled" ? "cancelled" : "done", seq },
      approvals: [],
    };
  if (event.type === "error")
    return {
      ...block,
      run: { ...run, status: "failed", seq },
      notice: text(event.message),
      approvals: [],
    };
  return block;
}
