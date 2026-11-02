import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { chat } from "../fixtures/pluginChat";
import { chatExecutionKey, type PluginChatBlock } from "@/lib/plugins/pluginChat";
const mock = vi.hoisted(() => ({
  run: vi.fn(),
  render: vi.fn(),
  listen: vi.fn(),
  authorize: vi.fn(),
}));
vi.mock("@/lib/api/ipc", () => ({
  api: { pluginRun: mock.run, pluginRenderView: mock.render },
  events: { onPluginEvent: mock.listen },
  isTauri: () => true,
}));
vi.mock("@/store/pluginSecurity", () => ({
  authorizePluginAction: mock.authorize,
  reportPluginExecutionFailure: vi.fn(),
}));
import i18n from "@/i18n/i18n";
import { PluginChat } from "@/features/plugins/PluginChat";
import { useDialogs } from "@/store/dialogs";

const target = {
  kind: "remote" as const,
  sessionId: "ssh",
  hostId: "host",
  title: "Build machine",
  home: "/home/test",
  cwd: "/home/test",
  platform: "posix" as const,
};
function block(status: "required" | "checking" | "ready" | "error" = "required"): PluginChatBlock {
  return {
    ...chat,
    execution: target,
    commands: {
      ...chat.commands,
      prepare: "ai.prepare",
      install: "ai.install",
      target: "ai.target",
    },
    readiness: {
      status,
      profileId: chat.modelId,
      targetKey: chatExecutionKey(target),
      detail: status === "error" ? "node: not found" : "",
    },
  };
}
beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage("en-US");
  useDialogs.getState().close();
  mock.run.mockResolvedValue({});
  mock.render.mockResolvedValue({});
  mock.authorize.mockResolvedValue(true);
  mock.listen.mockResolvedValue(() => {});
});

describe("agent preparation", () => {
  it("recovers completed readiness when the final event snapshot is lost", async () => {
    const completed = block("ready");
    completed.execution = {
      ...target,
      runtime: "/home/test/.tunnelde-runtime-new/bin/node",
      executable: "/home/test/.tunnelde-runtime-new/run-agent",
    };
    completed.readiness!.targetKey = chatExecutionKey(completed.execution);
    mock.render.mockResolvedValue({ blocks: [completed] });
    render(<PluginChat pluginId="assistant" viewId="chat" block={block("checking")} />);
    await screen.findByRole("button", { name: "Send" }, { timeout: 3500 });
    expect(mock.render).toHaveBeenCalledWith("assistant", "chat", "en-US");
    expect(mock.run).not.toHaveBeenCalled();
  });
  it("shows initialization instead of Send, blocks Enter, then preserves the draft for a verified target", async () => {
    mock.run.mockResolvedValueOnce({ block: block("ready") });
    render(<PluginChat pluginId="assistant" viewId="chat" block={block()} />);
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Keep this prompt" } });
    fireEvent.keyDown(screen.getByLabelText("Message"), { key: "Enter" });
    expect(mock.run).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Initialize" }));
    await screen.findByRole("button", { name: "Send" });
    expect(mock.run).toHaveBeenCalledWith(
      "assistant",
      "ai.prepare",
      expect.objectContaining({ modelId: chat.modelId }),
    );
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe(
      "Keep this prompt",
    );
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(mock.run).toHaveBeenCalledWith(
        "assistant",
        "ai.send",
        expect.objectContaining({ message: "Keep this prompt" }),
      ),
    );
  });

  it("offers installation after a failed check and keeps retryable errors outside conversation history", async () => {
    mock.run.mockResolvedValue({ block: block("checking") });
    render(<PluginChat pluginId="assistant" viewId="chat" block={block("error")} />);
    expect(screen.getByText("node: not found")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Install and initialize" }));
    await waitFor(() =>
      expect(mock.run).toHaveBeenCalledWith(
        "assistant",
        "ai.install",
        expect.objectContaining({ modelId: chat.modelId }),
      ),
    );
    await screen.findByRole("button", { name: "Cancel initialization" });
    expect(
      screen.getByRole("button", { name: "Execution location" }).hasAttribute("disabled"),
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Cancel initialization" }));
    await waitFor(() =>
      expect(mock.run).toHaveBeenCalledWith("assistant", "ai.stop", expect.anything()),
    );
    expect(screen.queryByText("You")).toBeNull();
  });

  it("rejects a ready status belonging to a different machine or model", () => {
    const ready = block("ready");
    const { rerender } = render(
      <PluginChat
        pluginId="assistant"
        viewId="chat"
        block={{ ...ready, execution: { ...target, sessionId: "other" } }}
      />,
    );
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    rerender(
      <PluginChat
        pluginId="assistant"
        viewId="chat"
        block={{ ...ready, readiness: { ...ready.readiness!, profileId: "other-profile" } }}
      />,
    );
    expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
  });
});
