import { describe, expect, it } from "vitest";
import {
  applyChatEvent,
  normalizeChatBlock,
  normalizeChatConfig,
  groupChatMessages,
} from "@/lib/plugins/pluginChat";
import { normalizeBlocks } from "@/lib/plugins/pluginView";
import { chat } from "../fixtures/pluginChat";

describe("controlled plugin chat payloads", () => {
  it("retains task run identities in snapshots and live task updates", () => {
    const task = { id: "runner", runId: "original-run", status: "interrupted", recoverable: true };
    const normalized = normalizeChatBlock({ ...chat, tasks: [task] })!;
    expect(normalized.tasks[0]?.runId).toBe("original-run");
    const running = { ...chat, run: { id: "current-run", status: "running" as const, seq: 0 } };
    const updated = applyChatEvent(running, "chat", {
      viewId: "chat",
      sessionId: chat.activeSessionId,
      runId: "current-run",
      seq: 1,
      type: "task",
      task,
    });
    expect(updated.tasks[0]?.runId).toBe("original-run");
  });
  it("marks a background session finished without replacing the current conversation or accepting another run", () => {
    const block = {
      ...chat,
      sessions: chat.sessions.map((session) => ({
        ...session,
        running: true,
        runId: "background-run",
      })),
    };
    const event = {
      viewId: "chat",
      type: "done",
      sessionId: "session-2",
      runId: "background-run",
      seq: 10,
    };
    expect(applyChatEvent(block, "chat", { ...event, runId: "stale-run" })).toBe(block);
    expect(applyChatEvent(block, "chat", { ...event, viewId: "other" })).toBe(block);
    const result = applyChatEvent(block, "chat", event);
    expect(result.sessions[1]?.running).toBe(false);
    expect(result.sessions[0]?.running).toBe(true);
    expect(result.messages).toBe(block.messages);
    expect(result.activeSessionId).toBe(block.activeSessionId);
  });
  it("groups work by user turn, preserves final replies and does not merge different turns", () => {
    const turns = groupChatMessages([
      { id: "u1", role: "user", content: "inspect" },
      {
        id: "a1",
        role: "assistant",
        content: "Checking",
        activity: [{ id: "r", kind: "reasoning", title: "", content: "summary" }],
      },
      { id: "t1", role: "tool", name: "list_sessions", content: "two machines" },
      { id: "a2", role: "assistant", content: "Final reply" },
      { id: "u2", role: "user", content: "next" },
    ]);
    expect(turns).toHaveLength(2);
    expect(turns[0]?.activity.map((item) => item.id)).toEqual(["r", "a1", "t1"]);
    expect(turns[0]?.reply?.content).toBe("Final reply");
    expect(turns[1]?.activity).toEqual([]);
  });
  it("merges bounded structured activity without duplicating text or accepting stale events", () => {
    const initial = {
      ...chat,
      run: { id: "run", status: "running" as const, seq: 1 },
      messages: [{ id: "a", role: "assistant" as const, content: "answer" }],
    };
    const event = {
      type: "activity",
      viewId: "chat",
      sessionId: chat.activeSessionId,
      runId: "run",
      seq: 2,
      messageId: "a",
      activity: [{ id: "tool", kind: "tool", title: "ls", content: "result", html: "<script>" }],
    };
    const next = applyChatEvent(initial, "chat", event);
    expect(next.messages[0]?.content).toBe("answer");
    expect(next.messages[0]?.activity?.[0]).not.toHaveProperty("html");
    expect(applyChatEvent(next, "chat", event)).toBe(next);
    const delta = applyChatEvent(next, "chat", { ...event, type: "delta", seq: 3, delta: "!" });
    expect(delta.messages[0]?.content).toBe("answer!");
    expect(delta.messages[0]?.activity).toEqual(next.messages[0]?.activity);
  });
  it("preserves execution target metadata and its command without exposing arbitrary properties", () => {
    const value = normalizeChatBlock({
      ...chat,
      commands: { ...chat.commands, target: "ai.target" },
      execution: {
        kind: "remote",
        sessionId: "ssh",
        hostId: "host",
        title: "Development",
        cwd: "/home/dev",
        home: "/home/dev",
        platform: "posix",
        runtime: "/bin/node",
        password: "secret",
      },
    })!;
    expect(value.commands.target).toBe("ai.target");
    expect(value.execution).toMatchObject({ kind: "remote", sessionId: "ssh", cwd: "/home/dev" });
    expect(value.execution).not.toHaveProperty("password");
  });

  it("preserves independent agent identity and refuses invalid profile policies", () => {
    const policy = {
      primaryProtocols: ["codex"],
      reviewerProtocols: ["openai-responses"],
      defaultProtocol: "codex",
    };
    expect(normalizeChatBlock({ ...chat, title: "Codex", profilePolicy: policy })).toMatchObject({
      title: "Codex",
      profilePolicy: policy,
    });
    for (const invalid of [
      { ...policy, primaryProtocols: [] },
      { ...policy, primaryProtocols: ["unknown"] },
      { ...policy, reviewerProtocols: "all" },
      { ...policy, defaultProtocol: "claude-code" },
    ])
      expect(normalizeChatBlock({ ...chat, profilePolicy: invalid })).toBeNull();
  });

  it("preserves execution mode and CLI parameters while dropping unsupported MCP settings", () => {
    const normalized = normalizeChatConfig({
      ...chat.config,
      mode: "readOnly",
      profiles: [
        {
          ...chat.config!.profiles[0],
          protocol: "pi",
          platform: "windows",
          provider: "custom-api",
          sessionId: "old-direct-session",
          helperBinary: "/runner.exe",
          remote: {
            sessionId: "remote-session",
            platform: "windows",
            directory: "C:\\agent",
            runnerPath: "/runner.exe",
            executable: "C:\\node.exe",
          },
        },
      ],
      mcpServers: [{ id: "unimplemented", token: "secret" }],
    })!;
    expect(normalized.mode).toBe("readOnly");
    expect(normalized.profiles[0]).toMatchObject({
      platform: "windows",
      provider: "custom-api",
      sessionId: "old-direct-session",
      helperBinary: "/runner.exe",
      remote: { sessionId: "remote-session", platform: "windows" },
    });
    expect(normalized).not.toHaveProperty("mcpServers");
    expect(normalizeChatConfig({ mode: "unknown" })?.mode).toBe("ask");
  });

  it("recognizes one controlled chat block, drops invalid commands and never accepts secrets from render payloads", () => {
    const blocks = normalizeBlocks([
      { ...chat, commands: { send: "__proto__", stop: "ai.stop" } },
      chat,
      { ...chat, id: "second" },
    ]);
    expect(blocks).toEqual([chat]);
    const source = {
      ...chat,
      config: {
        ...chat.config,
        profiles: [{ ...chat.config!.profiles[0], apiKey: "do-not-display" }],
      },
    };
    expect(JSON.stringify(normalizeChatBlock(source))).not.toContain("do-not-display");
  });

  it("defaults unknown modes to ask and bounds untrusted messages and task output", () => {
    const normalized = normalizeChatBlock({
      ...chat,
      mode: "allowEverything",
      messages: [
        { id: "a", role: "assistant", content: "x".repeat(300000) },
        { id: "bad", role: "html", content: "<iframe>" },
      ],
      tasks: [{ id: "task", status: "running", output: "x".repeat(70000) }],
    })!;
    expect(normalized.mode).toBe("ask");
    expect(normalized.messages).toHaveLength(1);
    expect(normalized.messages[0]!.content).toHaveLength(262144);
    expect(normalized.tasks[0]!.output).toHaveLength(65536);
  });

  const running = { ...chat, run: { id: "run-1", status: "running" as const, seq: 0 } };
  const delta = {
    viewId: "chat",
    sessionId: "session-1",
    runId: "run-1",
    seq: 1,
    type: "delta",
    messageId: "reply",
    delta: "Hello",
  };
  it("isolates streams by view, conversation, run and sequence", () => {
    for (const patch of [
      { viewId: "other" },
      { sessionId: "session-2" },
      { runId: "old-run" },
      { seq: -1 },
      { seq: 0 },
      { seq: 1.5 },
    ])
      expect(applyChatEvent(running, "chat", { ...delta, ...patch })).toBe(running);
    const first = applyChatEvent(running, "chat", delta);
    expect(first.messages[0]!.content).toBe("Hello");
    expect(applyChatEvent(first, "chat", delta)).toBe(first);
    expect(
      applyChatEvent(first, "chat", { ...delta, seq: 2, delta: " world" }).messages[0]!.content,
    ).toBe("Hello world");
  });

  it("does not let deltas rewrite user messages", () => {
    const source = {
      ...running,
      messages: [{ id: "reply", role: "user" as const, content: "Original" }],
    };
    expect(applyChatEvent(source, "chat", delta)).toBe(source);
  });

  it("adds explicit approval and interrupted task cards, then clears approval after cancellation", () => {
    const approval = applyChatEvent(running, "chat", {
      ...delta,
      type: "approval",
      approval: { id: "request", tool: "fs.write", title: "Write a file", command: "example" },
    });
    expect(approval.run?.status).toBe("waiting");
    expect(approval.approvals).toHaveLength(1);
    const task = applyChatEvent(approval, "chat", {
      ...delta,
      seq: 2,
      type: "task",
      task: { id: "task", title: "Long task", status: "interrupted", recoverable: true },
    });
    expect(task.tasks[0]!.recoverable).toBe(true);
    const done = applyChatEvent(task, "chat", {
      ...delta,
      seq: 3,
      type: "done",
      status: "cancelled",
    });
    expect(done.run?.status).toBe("cancelled");
    expect(done.approvals).toEqual([]);
    expect(done.tasks).toHaveLength(1);
  });

  it("requires a matching snapshot before attaching an unknown run", () => {
    expect(applyChatEvent(chat, "chat", delta)).toBe(chat);
    const snapshot = applyChatEvent(chat, "chat", { ...delta, type: "snapshot", block: running });
    expect(snapshot.run?.id).toBe("run-1");
    expect(snapshot.run?.seq).toBe(1);
  });
});
