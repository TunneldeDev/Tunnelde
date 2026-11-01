import { describe, expect, it } from "vitest";
import { applyChatEvent, normalizeChatBlock, normalizeChatConfig } from "@/lib/plugins/pluginChat";
import { normalizeBlocks } from "@/lib/plugins/pluginView";
import { chat } from "../fixtures/pluginChat";

describe("controlled plugin chat payloads", () => {
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
