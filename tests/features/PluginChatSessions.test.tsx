import { usePlugins } from "@/store/plugins";
import { plugin as installedPlugin } from "../fixtures/plugins";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { chat } from "../fixtures/pluginChat";

const mock = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("@/lib/api/ipc", () => ({
  api: { pluginRun: mock.run },
  events: {},
  isTauri: () => false,
}));
import i18n from "@/i18n/i18n";
import { PluginChat } from "@/features/plugins/PluginChat";
import { useSsh } from "@/store/ssh";
import { useHosts } from "@/store/hosts";
import { useDialogs } from "@/store/dialogs";
import type { Host } from "@/lib/api/types";

beforeEach(async () => {
  usePlugins.setState({
    items: [{ ...installedPlugin, id: "assistant", status: "running", runtimeId: "boot:1" }],
  });
  vi.clearAllMocks();
  await i18n.changeLanguage("en-US");
  mock.run.mockResolvedValue({});
  useSsh.setState({ sessions: [] });
  useHosts.setState({ hosts: [] });
  useDialogs.getState().close();
});

describe("assistant conversation history", () => {
  it("yields to a permission dialog while retaining an unfinished history rename", () => {
    render(<PluginChat pluginId="assistant" viewId="chat" block={chat} />);
    fireEvent.click(screen.getByRole("button", { name: "Conversation" }));
    fireEvent.click(screen.getByRole("button", { name: "Rename Second conversation" }));
    fireEvent.change(screen.getByLabelText("Conversation name"), {
      target: { value: "Unfinished name" },
    });
    act(() =>
      useDialogs.getState().confirm({
        title: "Permission",
        body: "Allow?",
        confirmLabel: "Allow",
        onConfirm: () => {},
      }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => useDialogs.getState().close());
    expect((screen.getByLabelText("Conversation name") as HTMLInputElement).value).toBe(
      "Unfinished name",
    );
    expect(mock.run).not.toHaveBeenCalled();
  });
  it("searches and deletes another conversation without selecting it or changing the draft", async () => {
    const block = { ...chat, run: { id: "active-run", seq: 1, status: "running" as const } };
    mock.run.mockResolvedValue({ block: { ...block, sessions: [block.sessions[0]] } });
    render(<PluginChat pluginId="assistant" viewId="chat" block={block} />);
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Conversation" }));
    const dialog = screen.getByRole("dialog");
    expect(
      (
        within(dialog).getByRole("button", {
          name: "Delete First conversation",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "second" } });
    expect(within(dialog).queryByRole("button", { name: "First conversation" })).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete Second conversation" }));
    expect(mock.run).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(mock.run).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete Second conversation" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(mock.run).toHaveBeenCalledWith(
        "assistant",
        "ai.session",
        expect.objectContaining({ action: "delete", sessionId: "session-2" }),
        "boot:1",
      ),
    );
    expect(mock.run).toHaveBeenCalledTimes(1);
    expect(screen.getByText("No conversations found")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("draft");
    expect(screen.getByRole("button", { name: "Conversation" }).textContent).toContain(
      "First conversation",
    );
  });

  it("renames a nonactive conversation in place and keeps it open if saving fails", async () => {
    render(<PluginChat pluginId="assistant" viewId="chat" block={chat} />);
    fireEvent.click(screen.getByRole("button", { name: "Approval mode" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "ReadOnly" }));
    fireEvent.click(screen.getByRole("button", { name: "Conversation" }));
    fireEvent.click(screen.getByRole("button", { name: "Rename Second conversation" }));
    fireEvent.change(screen.getByLabelText("Conversation name"), {
      target: { value: "Project notes" },
    });
    mock.run.mockRejectedValueOnce(new Error("Could not save"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(within(screen.getByRole("dialog")).getByRole("alert").textContent).toContain(
        "Could not save",
      ),
    );
    expect((screen.getByLabelText("Conversation name") as HTMLInputElement).value).toBe(
      "Project notes",
    );
    mock.run.mockResolvedValueOnce({
      block: {
        ...chat,
        sessions: [chat.sessions[0], { id: "session-2", title: "Project notes", untitled: false }],
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Project notes" })).toBeTruthy());
    expect(mock.run).toHaveBeenLastCalledWith(
      "assistant",
      "ai.session",
      expect.objectContaining({ action: "rename", sessionId: "session-2", title: "Project notes" }),
      "boot:1",
    );
    expect(screen.getByRole("button", { name: "Conversation" }).textContent).toContain(
      "First conversation",
    );
    expect(screen.getByRole("button", { name: "Approval mode" }).textContent).toContain("ReadOnly");
  });

  it("localizes old and new untitled sessions while keeping explicit titles across language changes", async () => {
    const block = {
      ...chat,
      sessions: [
        { id: "session-1", title: "New conversation" },
        { id: "session-2", title: "New conversation", untitled: false },
      ],
    };
    render(<PluginChat pluginId="assistant" viewId="chat" block={block} />);
    await act(async () => {
      await i18n.changeLanguage("zh-CN");
    });
    expect(screen.getByRole("button", { name: "会话" }).textContent).toContain("新会话");
    screen.getByRole("button", { name: "会话" }).focus();
    fireEvent.click(screen.getByRole("button", { name: "会话" }));
    expect(screen.getByRole("button", { name: "New conversation" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "新会话" })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("searchbox"), { key: "ArrowDown" });
    expect(document.activeElement?.getAttribute("data-session-id")).toBe("session-2");
    fireEvent.keyDown(document.activeElement!, { key: "End" });
    expect(document.activeElement?.getAttribute("data-session-id")).toBe("session-1");
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "会话" }));
  });

  it("keeps one target per host and address, the selected connection, and the current name after repeated renames", () => {
    const session = {
      id: "old",
      hostId: "host",
      title: "Old name",
      address: "user@server:22",
      cols: 80,
      rows: 24,
      connectedAt: 1,
    };
    useSsh.setState({
      sessions: [session, { ...session, id: "new", title: "Temporary name", connectedAt: 2 }],
    });
    useHosts.setState({ hosts: [{ id: "host", name: "Original name" } as Host] });
    render(
      <PluginChat
        pluginId="assistant"
        viewId="chat"
        block={{
          ...chat,
          commands: { ...chat.commands, target: "ai.target" },
          execution: {
            kind: "remote",
            sessionId: "old",
            hostId: "host",
            title: "Stale name",
            cwd: "/home/user",
            home: "/home/user",
            platform: "posix",
          },
        }}
      />,
    );
    const trigger = screen.getByRole("button", { name: "Execution location" });
    expect(trigger.textContent).toContain("Original name");
    fireEvent.click(trigger);
    expect(screen.getAllByRole("menuitemradio", { name: "Original name" })).toHaveLength(1);
    expect(
      screen.getByRole("menuitemradio", { name: "Original name" }).getAttribute("aria-checked"),
    ).toBe("true");
    act(() => useHosts.setState({ hosts: [{ id: "host", name: "Changed" } as Host] }));
    expect(screen.getByRole("menuitemradio", { name: "Changed" })).toBeTruthy();
    act(() => useHosts.setState({ hosts: [{ id: "host", name: "Original name" } as Host] }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Original name" }));
    expect(mock.run).not.toHaveBeenCalled();
    expect(trigger.textContent).toContain("Original name");
  });
});
