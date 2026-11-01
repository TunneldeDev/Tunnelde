import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { chat } from "../fixtures/pluginChat";
import type { PluginChatBlock } from "@/lib/plugins/pluginChat";

const mock = vi.hoisted(() => ({ run: vi.fn(), listen: vi.fn(), authorize: vi.fn() }));
vi.mock("@/lib/api/ipc", () => ({
  api: { pluginRun: mock.run },
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

beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage("en-US");
  mock.run.mockResolvedValue({});
  mock.listen.mockResolvedValue(() => {});
  mock.authorize.mockResolvedValue(true);
  useDialogs.getState().close();
});

function branded(protocol: "codex" | "claude-code" | "pi", title: string): PluginChatBlock {
  return {
    ...chat,
    title,
    profilePolicy: {
      primaryProtocols: [protocol],
      reviewerProtocols: ["openai-chat"],
      defaultProtocol: protocol,
    },
    config: { ...chat.config!, profiles: [{ ...chat.config!.profiles[0]!, protocol }] },
  };
}

describe("plugin chat presentation and controls", () => {
  it("keeps the model and execution controls inside the input card and permissions underneath", () => {
    const view = render(
      <PluginChat pluginId="assistant" viewId="chat" block={{ ...chat, title: "Tunnelde AI" }} />,
    );
    expect(view.container.querySelector(".plugin-chat--copilot")).toBeTruthy();
    const card = view.container.querySelector(".plugin-chat__input-card")!;
    expect(card.contains(screen.getByRole("button", { name: "Model" }))).toBe(true);
    expect(card.contains(screen.getByRole("button", { name: "Execution location" }))).toBe(true);
    expect(card.contains(screen.getByRole("button", { name: "Approval mode" }))).toBe(false);
    expect(screen.getByRole("heading", { name: "Tunnelde AI" })).toBeTruthy();
    expect(view.container.querySelector(".plugin-chat__selectors")).toBeNull();
  });

  it("switches to a configured SSH profile without starting a process or losing the draft", async () => {
    const remote = {
      ...chat.config!.profiles[0]!,
      id: "remote",
      name: "Remote agent",
      protocol: "codex" as const,
      remote: {
        sessionId: "ssh-session",
        platform: "posix" as const,
        directory: "/work",
        runnerPath: "/runner",
        executable: "/usr/bin/node",
      },
    };
    const block = {
      ...chat,
      models: [...chat.models, { id: remote.id, label: remote.name }],
      config: { ...chat.config!, profiles: [...chat.config!.profiles, remote] },
    };
    render(<PluginChat pluginId="assistant" viewId="chat" block={block} />);
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Keep this draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Execution location" }));
    const option = screen.getByRole("menuitemradio", { name: "SSH · Remote agent" });
    expect(option.getAttribute("aria-describedby")).toBeTruthy();
    fireEvent.click(option);
    expect(mock.run).not.toHaveBeenCalled();
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("Keep this draft");
    expect(screen.getByRole("button", { name: "Execution location" }).textContent).toContain("SSH");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(mock.run).toHaveBeenCalledWith(
        "assistant",
        "ai.send",
        expect.objectContaining({ modelId: "remote", message: "Keep this draft" }),
      ),
    );
  });

  it("shows real recent conversations for Codex and keeps its location above the composer", async () => {
    const block = branded("codex", "Codex");
    mock.run.mockImplementation(async (_plugin, _name, input) => ({
      block: { ...block, activeSessionId: input.sessionId },
    }));
    const view = render(<PluginChat pluginId="codex" viewId="chat" block={block} />);
    expect(
      view.container.querySelector(".plugin-chat--codex .plugin-chat__location-bar"),
    ).toBeTruthy();
    const card = view.container.querySelector(".plugin-chat__input-card")!;
    expect(card.contains(screen.getByRole("button", { name: "Approval mode" }))).toBe(true);
    expect(card.contains(screen.getByRole("button", { name: "Execution location" }))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Second conversation" }));
    await waitFor(() =>
      expect(mock.run).toHaveBeenCalledWith(
        "codex",
        "ai.session",
        expect.objectContaining({ action: "select", sessionId: "session-2" }),
      ),
    );
  });

  it.each([
    ["claude-code", "Claude Code", "claude"],
    ["pi", "Pi", "pi"],
  ] as const)(
    "gives %s its own brand and prevents unsupported readonly execution",
    (protocol, title, presentation) => {
      const view = render(
        <PluginChat
          pluginId={protocol}
          viewId="chat"
          block={{ ...branded(protocol, title), mode: "readOnly" }}
        />,
      );
      expect(
        view.container.querySelector(`.plugin-chat--${presentation} .plugin-chat__brand-header`)
          ?.textContent,
      ).toBe(title);
      fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Do work" } });
      expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(
        true,
      );
      fireEvent.keyDown(screen.getByLabelText("Message"), { key: "Enter" });
      expect(mock.run).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Approval mode" }));
      expect(
        (screen.getByRole("menuitemradio", { name: "ReadOnly" }) as HTMLButtonElement).disabled,
      ).toBe(true);
      expect(
        screen.getByRole("menuitemradio", { name: "ReadOnly" }).getAttribute("aria-describedby"),
      ).toBeTruthy();
      fireEvent.click(screen.getByRole("menuitemradio", { name: "Ask for approval" }));
      expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(
        false,
      );
    },
  );

  it("filters execution profiles by the independent plugin's primary protocol", () => {
    const block = branded("claude-code", "Claude Code");
    block.config!.profiles.push({
      ...chat.config!.profiles[0]!,
      id: "foreign",
      name: "Foreign provider",
    });
    render(<PluginChat pluginId="claude" viewId="chat" block={block} />);
    fireEvent.click(screen.getByRole("button", { name: "Execution location" }));
    expect(screen.queryByRole("menuitemradio", { name: /Foreign provider/ })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Configure Claude Code" })).toBeTruthy();
  });

  it("keeps the stop control and blocks profile changes while a branded assistant is running", async () => {
    render(
      <PluginChat
        pluginId="codex"
        viewId="chat"
        block={{ ...branded("codex", "Codex"), run: { id: "run", seq: 1, status: "running" } }}
      />,
    );
    for (const name of ["Model", "Approval mode", "Execution location"])
      expect((screen.getByRole("button", { name }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await waitFor(() =>
      expect(mock.run).toHaveBeenCalledWith(
        "codex",
        "ai.stop",
        expect.objectContaining({ runId: "run" }),
      ),
    );
    await act(async () => Promise.resolve());
  });
});
