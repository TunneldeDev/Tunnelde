import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Profiler } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginEvent } from "@/lib/api/types";
import { chat } from "../fixtures/pluginChat";
import { deferred } from "../fixtures/plugins";
const mock = vi.hoisted(() => ({
  run: vi.fn(),
  listen: vi.fn(),
  unlisten: vi.fn(),
  authorize: vi.fn(),
  copy: vi.fn(),
  pickExecutable: vi.fn(),
  pickFolder: vi.fn(),
  renderView: vi.fn(),
}));
vi.mock("@/lib/api/ipc", () => ({
  api: {
    pluginRun: mock.run,
    pluginPickExecutable: mock.pickExecutable,
    pluginPickFolder: mock.pickFolder,
    pluginRenderView: mock.renderView,
  },
  events: { onPluginEvent: mock.listen },
  isTauri: () => true,
}));
vi.mock("@/store/pluginSecurity", () => ({
  authorizePluginAction: mock.authorize,
  reportPluginExecutionFailure: vi.fn(),
}));
vi.mock("@/lib/session/clipboard", () => ({ copyText: mock.copy }));
import i18n from "@/i18n/i18n";
import { PluginChat } from "@/features/plugins/PluginChat";
import { normalizeChatBlock, type PluginChatBlock } from "@/lib/plugins/pluginChat";
import { useDialogs } from "@/store/dialogs";
let publish: (event: PluginEvent) => void;
beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage("en-US");
  mock.run.mockResolvedValue({});
  mock.authorize.mockResolvedValue(true);
  mock.pickExecutable.mockResolvedValue(null);
  mock.pickFolder.mockResolvedValue(null);
  mock.listen.mockImplementation(async (handler) => {
    publish = handler;
    return mock.unlisten;
  });
  useDialogs.getState().close();
});
afterEach(() => vi.useRealTimers());
const emit = (payload: unknown, pluginId = "assistant", generation = 1) =>
  act(() => publish({ pluginId, generation, event: "chat", payload }));

describe("controlled plugin chat", () => {
  it("buffers hidden streaming updates without React commits and restores the latest state and draft", async () => {
    const onRender = vi.fn();
    const block: PluginChatBlock = { ...chat, run: { id: "run-1", status: "running", seq: 0 } };
    const content = (visible: boolean) => (
      <Profiler id="chat" onRender={onRender}>
        <PluginChat pluginId="assistant" viewId="chat" block={block} visible={visible} />
      </Profiler>
    );
    const view = render(content(true));
    await act(async () => {});
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Keep my draft" } });
    view.rerender(content(false));
    const commits = onRender.mock.calls.length;
    const event = {
      viewId: "chat",
      sessionId: "session-1",
      runId: "run-1",
      messageId: "reply",
      type: "delta",
      delta: "x",
    };
    for (let seq = 1; seq <= 20; seq++) emit({ ...event, seq }, "assistant", 2);
    emit({ ...event, seq: 21, delta: "stale" }, "assistant", 1);
    emit({ ...event, seq: 21, type: "done", status: "done" }, "assistant", 2);
    expect(onRender).toHaveBeenCalledTimes(commits);
    expect(screen.queryByText("x".repeat(20))).toBeNull();
    view.rerender(content(true));
    expect(screen.getByText("x".repeat(20))).toBeTruthy();
    expect(screen.queryByText(/stale/)).toBeNull();
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("Keep my draft");
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
    expect(mock.listen).toHaveBeenCalledOnce();
    expect(mock.unlisten).not.toHaveBeenCalled();
    expect(mock.run).not.toHaveBeenCalled();
  });

  it("suspends hidden readiness polling and ignores an in-flight response after hiding", async () => {
    vi.useFakeTimers();
    const block: PluginChatBlock = {
      ...chat,
      readiness: { status: "checking", profileId: chat.modelId, targetKey: "local", detail: "" },
    };
    const response = deferred<unknown>();
    mock.renderView.mockReturnValueOnce(response.promise).mockResolvedValue({ blocks: [block] });
    const view = render(
      <PluginChat pluginId="assistant" viewId="chat" block={block} visible={false} />,
    );
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(mock.renderView).not.toHaveBeenCalled();
    view.rerender(<PluginChat pluginId="assistant" viewId="chat" block={block} visible />);
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(mock.renderView).toHaveBeenCalledOnce();
    view.rerender(<PluginChat pluginId="assistant" viewId="chat" block={block} visible={false} />);
    await act(async () =>
      response.resolve({
        blocks: [
          { ...block, messages: [{ id: "old", role: "assistant", content: "Stale readiness" }] },
        ],
      }),
    );
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(mock.renderView).toHaveBeenCalledOnce();
    view.rerender(<PluginChat pluginId="assistant" viewId="chat" block={block} visible />);
    expect(screen.queryByText("Stale readiness")).toBeNull();
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(mock.renderView).toHaveBeenCalledTimes(2);
    expect(mock.run).not.toHaveBeenCalled();
    expect(mock.listen).toHaveBeenCalledOnce();
  });

  it("omits empty assistant turns and keeps raw tool output collapsed with an explicit copy action", async () => {
    const output = '{"sha256":"abc","content":"tool result"}';
    const view = render(
      <PluginChat
        pluginId="assistant"
        viewId="chat"
        block={{
          ...chat,
          messages: [
            { id: "empty", role: "assistant", content: "  ", status: "done" },
            { id: "tool", role: "tool", content: output },
            { id: "answer", role: "assistant", content: "**Read successfully**" },
          ],
        }}
      />,
    );
    expect(view.container.querySelectorAll(".plugin-chat__message.is-assistant")).toHaveLength(1);
    expect(screen.getByText("Read successfully").tagName).toBe("STRONG");
    const summary = screen.getByText("Tool output");
    const details = summary.closest("details")!;
    expect(details.open).toBe(false);
    fireEvent.click(summary);
    expect(details.open).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Copy tool output" }));
    await waitFor(() => expect(mock.copy).toHaveBeenCalledWith(output));
    expect(mock.run).not.toHaveBeenCalled();
  });

  it("retains saved execution settings when editing a provider and hides unsupported MCP configuration", async () => {
    const block = normalizeChatBlock({
      ...chat,
      config: {
        ...chat.config,
        mode: "readOnly",
        profiles: [
          {
            ...chat.config!.profiles[0],
            protocol: "pi",
            platform: "windows",
            provider: "custom-api",
            sessionId: "legacy-session",
            executable: "C:\\pi.exe",
            remote: {
              sessionId: "remote-session",
              platform: "windows",
              directory: "C:\\agent",
              runnerPath: "/runner.exe",
              executable: "C:\\node.exe",
            },
          },
        ],
        mcpServers: [{ id: "unsupported", token: "secret" }],
      },
    })!;
    render(<PluginChat pluginId="assistant" viewId="chat" block={block} />);
    fireEvent.click(screen.getByRole("button", { name: "Configure assistant" }));
    expect(screen.queryByRole("button", { name: "MCP servers" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Provider name"), {
      target: { value: "Renamed profile" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(mock.run).toHaveBeenCalledOnce());
    const input = mock.run.mock.calls[0]![2];
    expect(input.config).toMatchObject({
      mode: "readOnly",
      profiles: [
        {
          name: "Renamed profile",
          platform: "windows",
          provider: "custom-api",
          sessionId: "legacy-session",
          remote: { sessionId: "remote-session", platform: "windows", executable: "C:\\node.exe" },
        },
      ],
    });
    expect(input.config).not.toHaveProperty("mcpServers");
  });

  it("can retry event registration without sending a command or losing the draft", async () => {
    mock.listen.mockRejectedValueOnce(new Error("Event connection failed"));
    render(<PluginChat pluginId="assistant" viewId="chat" block={chat} />);
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Keep draft" } });
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "Event connection failed",
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(mock.listen).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(mock.run).not.toHaveBeenCalled();
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("Keep draft");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(mock.run).toHaveBeenCalledOnce());
  });

  it("uses native pickers for local CLI configuration and leaves values intact on cancel", async () => {
    const config = {
      ...chat.config!,
      profiles: [
        {
          ...chat.config!.profiles[0]!,
          protocol: "codex" as const,
          executable: "/old/codex",
          cwd: "/old/work",
        },
      ],
    };
    render(<PluginChat pluginId="assistant" viewId="chat" block={{ ...chat, config }} />);
    fireEvent.click(screen.getByRole("button", { name: "Configure assistant" }));
    fireEvent.click(screen.getByRole("button", { name: "Browse · Executable path" }));
    await waitFor(() => expect(mock.pickExecutable).toHaveBeenCalledWith("Executable path"));
    expect((screen.getByLabelText("Executable path") as HTMLInputElement).value).toBe("/old/codex");
    mock.pickFolder.mockResolvedValue("/chosen/work");
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(
        false,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Browse · Working directory" }));
    await waitFor(() =>
      expect((screen.getByLabelText("Working directory") as HTMLInputElement).value).toBe(
        "/chosen/work",
      ),
    );
    expect(mock.run).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("switch", { name: "Run over SSH" }));
    expect(
      (screen.getByLabelText("Remote Node executable (explicit path)") as HTMLInputElement).value,
    ).toBe("");
    expect(screen.queryByLabelText("Remote helper executable")).toBeNull();
    mock.pickExecutable.mockResolvedValue("/downloads/runner-linux-arm64");
    fireEvent.click(
      screen.getByRole("button", { name: "Browse · Local helper binary for deployment" }),
    );
    await waitFor(() =>
      expect(
        (screen.getByLabelText("Local helper binary for deployment") as HTMLInputElement).value,
      ).toBe("/downloads/runner-linux-arm64"),
    );
  });

  it("waits for subscription and explicit sending, then isolates and deduplicates streamed Markdown", async () => {
    const subscription = deferred<() => void>();
    mock.listen.mockImplementationOnce((handler) => {
      publish = handler;
      return subscription.promise;
    });
    render(<PluginChat pluginId="assistant" viewId="chat" block={chat} />);
    expect(mock.run).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Help with files" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await act(async () => Promise.resolve());
    expect(mock.run).not.toHaveBeenCalled();
    await act(async () => subscription.resolve(mock.unlisten));
    await waitFor(() => expect(mock.run).toHaveBeenCalledOnce());
    expect(mock.run.mock.calls[0]!.slice(0, 2)).toEqual(["assistant", "ai.send"]);
    const input = mock.run.mock.calls[0]![2];
    expect(input).toMatchObject({
      sessionId: "session-1",
      message: "Help with files",
      mode: "ask",
      modelId: "provider-1",
    });
    const event = {
      viewId: "chat",
      sessionId: "session-1",
      runId: input.runId,
      seq: 1,
      type: "delta",
      messageId: "reply",
      delta: "**Ready**",
    };
    emit(event, "other");
    emit({ ...event, sessionId: "session-2" });
    emit({ ...event, runId: "stale" });
    expect(screen.queryByText("Ready")).toBeNull();
    emit(event);
    expect(screen.getByText("Ready").tagName).toBe("STRONG");
    emit(event);
    expect(screen.getByText("Ready").textContent).toBe("Ready");
    emit({ ...event, seq: 2, type: "done", status: "done" });
    expect(screen.getByRole("button", { name: "Send" })).toBeTruthy();
  });

  it("keeps streamed output when an older command snapshot returns after the first delta", async () => {
    const response = deferred<unknown>();
    mock.run.mockReturnValueOnce(response.promise);
    render(<PluginChat pluginId="assistant" viewId="chat" block={chat} />);
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Hello" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(mock.run).toHaveBeenCalledOnce());
    const runId = mock.run.mock.calls[0]![2].runId;
    emit({
      viewId: "chat",
      sessionId: "session-1",
      runId,
      seq: 1,
      type: "delta",
      messageId: "reply",
      delta: "Latest response",
    });
    await act(async () =>
      response.resolve({ block: { ...chat, run: { id: runId, status: "running", seq: 0 } } }),
    );
    expect(screen.getByText("Latest response")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() =>
      expect(mock.run).toHaveBeenLastCalledWith(
        "assistant",
        "ai.stop",
        expect.objectContaining({ runId }),
      ),
    );
  });

  it("preserves the draft and never calls a command if execution permission is denied", async () => {
    mock.authorize.mockResolvedValue(false);
    render(<PluginChat pluginId="assistant" viewId="chat" block={chat} />);
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Keep my draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(mock.authorize).toHaveBeenCalledOnce());
    expect(mock.run).not.toHaveBeenCalled();
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("Keep my draft");
  });

  it("does not run after the view unmounts while authorization is pending", async () => {
    const permission = deferred<boolean>();
    mock.authorize.mockReturnValueOnce(permission.promise);
    const view = render(<PluginChat pluginId="assistant" viewId="chat" block={chat} />);
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Cancelled action" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    view.unmount();
    await act(async () => permission.resolve(true));
    expect(mock.run).not.toHaveBeenCalled();
    expect(mock.unlisten).toHaveBeenCalledOnce();
  });

  it("shows approval details and sends only the decision explicitly selected", async () => {
    render(
      <PluginChat
        pluginId="assistant"
        viewId="chat"
        block={{
          ...chat,
          run: { id: "run", status: "waiting", seq: 1 },
          approvals: [
            {
              id: "request",
              tool: "fs.write",
              title: "Write configuration",
              detail: "Changes a local file",
              command: "write config.json",
              risk: "write",
            },
          ],
        }}
      />,
    );
    expect(screen.getByText("write config.json")).toBeTruthy();
    expect(mock.run).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    await waitFor(() =>
      expect(mock.run).toHaveBeenCalledWith(
        "assistant",
        "ai.approve",
        expect.objectContaining({ requestId: "request", decision: "deny" }),
      ),
    );
  });

  it("requires confirmation before full access and passes the chosen mode on send", async () => {
    render(<PluginChat pluginId="assistant" viewId="chat" block={chat} />);
    fireEvent.click(screen.getByRole("button", { name: "Approval mode" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: i18n.t("pluginChat.modes.full") }));
    const dialog = useDialogs.getState().dialog;
    expect(dialog.kind).toBe("confirm");
    expect(screen.getByRole("button", { name: "Approval mode" }).textContent).toContain(
      i18n.t("pluginChat.modes.ask"),
    );
    await act(async () => {
      if (dialog.kind === "confirm") await dialog.onConfirm();
      useDialogs.getState().close();
    });
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Act within scope" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(mock.run).toHaveBeenCalledWith(
        "assistant",
        "ai.send",
        expect.objectContaining({ mode: "full" }),
      ),
    );
  });

  it("restores task output without automatically resuming an interrupted task", async () => {
    render(
      <PluginChat
        pluginId="assistant"
        viewId="chat"
        block={{
          ...chat,
          tasks: [
            {
              id: "task",
              runId: "original-run",
              title: "Server check",
              status: "interrupted",
              output: "Saved progress",
              inspection: "Status: completed\nExit code: 0",
              recoverable: true,
            },
          ],
        }}
      />,
    );
    expect(mock.run).not.toHaveBeenCalled();
    expect(screen.getByText("Saved progress")).toBeTruthy();
    const inspected = screen.getByText("Status: completed", { exact: false }).closest("details");
    expect(inspected?.open).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Continue task" }));
    await waitFor(() =>
      expect(mock.run).toHaveBeenCalledWith(
        "assistant",
        "ai.recover",
        expect.objectContaining({ taskId: "task", taskRunId: "original-run", action: "resume" }),
      ),
    );
  });

  it("inspects the task's captured run instead of replacing it with the latest conversation run", async () => {
    render(
      <PluginChat
        pluginId="assistant"
        viewId="chat"
        block={{
          ...chat,
          run: { id: "latest-run", status: "failed", seq: 8 },
          tasks: [
            {
              id: "shared-runner",
              runId: "original-run",
              title: "Saved task",
              status: "interrupted",
              output: "",
              recoverable: true,
            },
          ],
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Inspect task" }));
    await waitFor(() =>
      expect(mock.run).toHaveBeenCalledWith(
        "assistant",
        "ai.recover",
        expect.objectContaining({
          taskId: "shared-runner",
          taskRunId: "original-run",
          runId: "latest-run",
          action: "inspect",
        }),
      ),
    );
  });

  it("keeps API keys masked, saves them only on explicit configuration and forgets them after closing", async () => {
    render(<PluginChat pluginId="assistant" viewId="chat" block={chat} />);
    fireEvent.click(screen.getByRole("button", { name: "Configure assistant" }));
    const secret = screen.getByLabelText("API key") as HTMLInputElement;
    expect(secret.type).toBe("password");
    expect(secret.autocomplete).toBe("off");
    expect(secret.value).toBe("");
    fireEvent.change(secret, { target: { value: "private-test-key" } });
    expect(mock.run).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(mock.run).toHaveBeenCalledWith(
        "assistant",
        "ai.configure",
        expect.objectContaining({
          config: expect.objectContaining({
            profiles: [expect.objectContaining({ apiKey: "private-test-key" })],
          }),
        }),
      ),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Configure assistant" }));
    expect((screen.getByLabelText("API key") as HTMLInputElement).value).toBe("");
  });

  it("retains each conversation draft while switching sessions and ignores older plugin generations", async () => {
    mock.run.mockImplementation(async (_id, name, input) =>
      name === "ai.session" ? { block: { ...chat, activeSessionId: input.sessionId } } : {},
    );
    render(<PluginChat pluginId="assistant" viewId="chat" block={chat} />);
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "First draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Conversation" }));
    fireEvent.click(screen.getByRole("button", { name: "Second conversation" }));
    await waitFor(() =>
      expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe(""),
    );
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Second draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Conversation" }));
    fireEvent.click(screen.getByRole("button", { name: "First conversation" }));
    await waitFor(() =>
      expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("First draft"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(mock.run).toHaveBeenCalledTimes(3));
    const runId = mock.run.mock.calls[2]![2].runId;
    const event = {
      viewId: "chat",
      sessionId: "session-1",
      runId,
      seq: 1,
      type: "delta",
      messageId: "reply",
      delta: "New generation",
    };
    emit(event, "assistant", 2);
    emit({ ...event, seq: 2, delta: " stale data" }, "assistant", 1);
    expect(screen.getByText("New generation")).toBeTruthy();
    expect(screen.queryByText(/stale data/)).toBeNull();
  });
});
