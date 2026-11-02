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
import { useSsh } from "@/store/ssh";
import { useHosts } from "@/store/hosts";

beforeEach(async () => {
  vi.clearAllMocks();
  await i18n.changeLanguage("en-US");
  mock.run.mockResolvedValue({});
  mock.listen.mockResolvedValue(() => {});
  mock.authorize.mockResolvedValue(true);
  useDialogs.getState().close();
  useSsh.setState({ sessions: [] });
  useHosts.setState({ hosts: [] });
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
  it("retains a thinking-only response after completion", () => {
    render(
      <PluginChat
        pluginId="assistant"
        viewId="chat"
        block={{
          ...chat,
          messages: [
            {
              id: "thinking",
              role: "assistant",
              content: "",
              status: "done",
              activity: [
                { id: "reason", kind: "reasoning", title: "", content: "Thought summary" },
              ],
            },
          ],
        }}
      />,
    );
    expect(screen.getByText("Activity")).toBeTruthy();
    expect(screen.getByText("Thought summary")).toBeTruthy();
  });
  it("lists live SSH machines independently of model profiles and keeps the composer draft", async () => {
    const block = branded("codex", "Codex");
    block.commands = { ...block.commands, target: "ai.target" };
    useSsh.setState({
      sessions: [
        {
          id: "ssh-one",
          hostId: "host-one",
          title: "Development",
          address: "dev:22",
          cols: 80,
          rows: 24,
          connectedAt: 0,
        },
        {
          id: "ssh-two",
          hostId: "host-two",
          title: "Build host",
          address: "build:22",
          cols: 80,
          rows: 24,
          connectedAt: 0,
        },
      ],
    });
    mock.run.mockResolvedValue({
      block: {
        ...block,
        activeSessionId: "new-target-conversation",
        sessions: [...block.sessions, { id: "new-target-conversation", title: "New conversation" }],
        execution: {
          kind: "remote",
          sessionId: "ssh-two",
          title: "Build host",
          home: "/home/dev",
          cwd: "/home/dev",
          platform: "posix",
        },
      },
    });
    render(<PluginChat pluginId="codex" viewId="chat" block={block} />);
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Keep my draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Execution location" }));
    expect(screen.getByRole("menuitemradio", { name: "Local" })).toBeTruthy();
    expect(screen.getByRole("menuitemradio", { name: "Development" })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Build host" }));
    await waitFor(() =>
      expect(mock.run).toHaveBeenCalledWith(
        "codex",
        "ai.target",
        expect.objectContaining({ targetId: "ssh-two", modelId: block.modelId }),
      ),
    );
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("Keep my draft");
    expect(screen.getByRole("button", { name: "Execution location" }).textContent).toContain(
      "Build host",
    );
    expect(mock.run).not.toHaveBeenCalledWith("codex", "ai.send", expect.anything());
    // A newly connected host appears without remounting or editing the model.
    act(() =>
      useSsh.setState((state) => ({
        sessions: [
          ...state.sessions,
          {
            id: "ssh-three",
            hostId: "host-three",
            title: "New host",
            address: "new:22",
            cols: 80,
            rows: 24,
            connectedAt: 0,
          },
        ],
      })),
    );
    fireEvent.click(screen.getByRole("button", { name: "Execution location" }));
    expect(screen.getByRole("menuitemradio", { name: "New host" })).toBeTruthy();
  });

  it("selects a remote machine directly without requiring a runtime path or starting its agent", async () => {
    const block = { ...chat, commands: { ...chat.commands, target: "ai.target" } };
    useSsh.setState({
      sessions: [
        {
          id: "ssh",
          hostId: "host",
          title: "Remote machine",
          address: "remote:22",
          cols: 80,
          rows: 24,
          connectedAt: 0,
        },
      ],
    });
    render(<PluginChat pluginId="assistant" viewId="chat" block={block} />);
    fireEvent.click(screen.getByRole("button", { name: "Execution location" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Remote machine" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() =>
      expect(mock.run).toHaveBeenCalledWith(
        "assistant",
        "ai.target",
        expect.objectContaining({ targetId: "ssh", modelId: block.modelId }),
      ),
    );
    expect(mock.run).toHaveBeenCalledTimes(1);
    expect(mock.run.mock.calls[0]![2]).not.toHaveProperty("runtime");
  });

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
    expect(screen.queryByRole("menuitem", { name: "Configure Claude Code" })).toBeNull();
    expect(screen.getByRole("button", { name: "Configure Claude Code" })).toBeTruthy();
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
