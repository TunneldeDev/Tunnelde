import { usePlugins } from "@/store/plugins";
import { plugin as installedPlugin } from "../fixtures/plugins";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Host, SshSession } from "@/lib/api/types";
import { chat } from "../fixtures/pluginChat";
import { deferred } from "../fixtures/plugins";

const mock = vi.hoisted(() => ({
  run: vi.fn(),
  listen: vi.fn(),
  authorize: vi.fn(),
  connect: vi.fn(),
  sshProbe: vi.fn(),
  sshTrust: vi.fn(),
  credentialStatus: vi.fn(),
  connectionRoute: vi.fn(),
  invoke: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mock.invoke }));
vi.mock("@/lib/api/ipc", () => ({
  api: {
    pluginRun: mock.run,
    sshProbe: mock.sshProbe,
    sshTrust: mock.sshTrust,
    credentialStatus: mock.credentialStatus,
    connectionRoute: mock.connectionRoute,
  },
  events: { onPluginEvent: mock.listen },
  isTauri: () => true,
}));
vi.mock("@/store/pluginSecurity", () => ({
  authorizePluginAction: mock.authorize,
  reportPluginExecutionFailure: vi.fn(),
}));
import i18n from "@/i18n/i18n";
import { PluginChat } from "@/features/plugins/PluginChat";
import { useHosts } from "@/store/hosts";
import { useSsh } from "@/store/ssh";
import { useDialogs } from "@/store/dialogs";
import { useWorkspace } from "@/store/workspace";

const host: Host = {
  id: "host",
  groupId: null,
  name: "Build server",
  host: "server.test",
  port: 22,
  username: "dev",
  authMethod: "password",
  keyPath: null,
  favorite: false,
  color: null,
  tags: [],
  note: null,
  sortOrder: 0,
  lastUsedAt: null,
  createdAt: 0,
  updatedAt: 0,
};
const session: SshSession = {
  id: "background-ssh",
  hostId: host.id,
  title: host.name,
  address: "dev@server.test:22",
  cols: 120,
  rows: 32,
  connectedAt: 1,
  terminal: false,
};
const block = { ...chat, commands: { ...chat.commands, target: "ai.target" } };
const known = { algorithm: "ssh-ed25519", fingerprint: "SHA256:qa", status: "known" };

beforeEach(async () => {
  usePlugins.setState({
    items: [{ ...installedPlugin, id: "assistant", status: "running", runtimeId: "boot:1" }],
  });
  vi.clearAllMocks();
  await i18n.changeLanguage("en-US");
  useHosts.setState({ hosts: [host] });
  useSsh.setState({ sessions: [], connect: mock.connect });
  useDialogs.getState().close();
  mock.run.mockResolvedValue({});
  mock.listen.mockResolvedValue(() => {});
  mock.authorize.mockResolvedValue(true);
  mock.connect.mockResolvedValue(session);
  mock.sshProbe.mockResolvedValue(known);
  mock.sshTrust.mockResolvedValue(known);
  mock.credentialStatus.mockResolvedValue(true);
  mock.connectionRoute.mockResolvedValue({ proxy: "", jumpHosts: [] });
  mock.invoke.mockReset().mockImplementation(async (command, args) => {
    if (command === "connection_review_prepare")
      return { review: { hostId: args.displayed.id, revision: "reviewed-host" }, jumpHosts: [] };
    if (command === "connection_review_probe")
      return mock.sshProbe(args.review.hostId, args.credentials);
    if (command === "connection_review_trust")
      return {
        info: await mock.sshTrust(
          args.review.hostId,
          args.fingerprint,
          args.credentials,
          args.expectedHostId,
        ),
        review: { ...args.review, revision: "explicitly-trusted" },
      };
    throw new Error(`Unmocked native command: ${command}`);
  });
});

async function openSavedHost() {
  fireEvent.click(screen.getByRole("button", { name: "Execution location" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Connect · Build server" }));
  await screen.findByText("Trusted");
  await waitFor(() =>
    expect((screen.getByRole("button", { name: "Connect" }) as HTMLButtonElement).disabled).toBe(
      false,
    ),
  );
}

describe("assistant connection from execution location", () => {
  it("connects a saved host in the background and selects it without opening terminal or files", async () => {
    const terminal = vi.spyOn(useWorkspace.getState(), "openTerminal");
    const files = vi.spyOn(useWorkspace.getState(), "openSftp");
    render(<PluginChat pluginId="assistant" viewId="chat" block={block} />);
    await openSavedHost();
    expect(mock.run).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() =>
      expect(mock.run).toHaveBeenCalledWith(
        "assistant",
        "ai.target",
        expect.objectContaining({
          targetId: session.id,
          sessionId: chat.activeSessionId,
          modelId: chat.modelId,
        }),
        "boot:1",
      ),
    );
    expect(mock.connect).toHaveBeenCalledWith(
      expect.objectContaining({ hostId: host.id, background: true }),
      expect.any(Function),
      expect.objectContaining({ key: expect.any(String), connect: expect.any(Function) }),
    );
    expect(terminal).not.toHaveBeenCalled();
    expect(files).not.toHaveBeenCalled();
    expect(mock.run.mock.calls.some((call) => call[1] === "ai.send")).toBe(false);
  });

  it("requires host-key approval before connecting and selecting the remote", async () => {
    mock.sshProbe.mockResolvedValue({ ...known, status: "unknown" });
    render(<PluginChat pluginId="assistant" viewId="chat" block={block} />);
    fireEvent.click(screen.getByRole("button", { name: "Execution location" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Connect · Build server" }));
    const trust = await screen.findByRole("button", { name: "Trust and continue" });
    expect(mock.connect).not.toHaveBeenCalled();
    expect(mock.run).not.toHaveBeenCalled();
    fireEvent.click(trust);
    await waitFor(() => expect(mock.run).toHaveBeenCalledOnce());
    expect(mock.sshTrust).toHaveBeenCalledExactlyOnceWith(host.id, known.fingerprint, {}, host.id);
  });

  it("keeps the existing target and message draft when connection is cancelled", async () => {
    render(<PluginChat pluginId="assistant" viewId="chat" block={block} />);
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "Keep this draft" } });
    await openSavedHost();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(mock.connect).not.toHaveBeenCalled();
    expect(mock.run).not.toHaveBeenCalled();
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toBe("Keep this draft");
  });

  it.each(["conversation", "model"])(
    "does not retarget a changed %s after a delayed connection succeeds",
    async (changed) => {
      const connection = deferred<SshSession>();
      mock.connect.mockReturnValue(connection.promise);
      const view = render(<PluginChat pluginId="assistant" viewId="chat" block={block} />);
      await openSavedHost();
      fireEvent.click(screen.getByRole("button", { name: "Connect" }));
      await waitFor(() => expect(mock.connect).toHaveBeenCalledOnce());
      view.rerender(
        <PluginChat
          pluginId="assistant"
          viewId="chat"
          block={{
            ...block,
            ...(changed === "conversation"
              ? { activeSessionId: "session-2" }
              : { modelId: "another-provider" }),
          }}
        />,
      );
      await act(async () => {
        connection.resolve(session);
        await connection.promise;
      });
      expect(mock.run).not.toHaveBeenCalled();
    },
  );

  it("keeps a failed connection retryable without changing the execution target", async () => {
    mock.connect.mockImplementation(async (_request, onError) => {
      onError(new Error("QA authentication failed"));
      return null;
    });
    render(<PluginChat pluginId="assistant" viewId="chat" block={block} />);
    await openSavedHost();
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await screen.findByText("QA authentication failed");
    expect(mock.run).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Connect" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    mock.connect.mockResolvedValue(session);
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(mock.run).toHaveBeenCalledOnce());
  });

  it("selects an existing connection without asking for credentials again", async () => {
    useSsh.setState({ sessions: [session] });
    render(<PluginChat pluginId="assistant" viewId="chat" block={block} />);
    fireEvent.click(screen.getByRole("button", { name: "Execution location" }));
    expect(screen.queryByRole("menuitem", { name: "Connect · Build server" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitemradio", { name: "Build server" }));
    await waitFor(() =>
      expect(mock.run).toHaveBeenCalledWith(
        "assistant",
        "ai.target",
        expect.objectContaining({ targetId: session.id }),
        "boot:1",
      ),
    );
    expect(mock.connect).not.toHaveBeenCalled();
    expect(mock.sshProbe).not.toHaveBeenCalled();
  });
});
