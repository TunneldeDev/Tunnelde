import { beforeEach, expect, it, vi } from "vitest";
import { discoverMountedFileActions, revealMountedFile } from "@/lib/plugins/mountFileMenu";
import { usePlugins } from "@/store/plugins";
import { usePluginSecurity } from "@/store/pluginSecurity";
import { useSsh } from "@/store/ssh";
import { useToasts } from "@/store/toasts";
import { plugin } from "../fixtures/plugins";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@/lib/api/ipc", () => ({ isTauri: () => true, api: {} }));

const owner = {
  ...plugin,
  id: "mount-owner",
  runtime: "declarative" as const,
  fingerprint: "original",
  mountedFileReveal: true,
  permissions: ["mounts.read", "mounts.write"],
};
const record = {
  id: "mount-1",
  sessionId: "ssh-1",
  remotePath: "/work",
  mountPoint: "Z:\\",
  cleanupError: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  useToasts.setState({ items: [] });
  usePlugins.setState({ items: [owner] });
  useSsh.setState({ sessions: [{ id: "ssh-1" } as never] });
  usePluginSecurity.setState({
    state: {
      restricted: false,
      cliLocked: false,
      recoverySuggested: false,
      reason: null,
      grants: { [owner.id]: owner.permissions },
    },
  });
  mocks.invoke.mockResolvedValue([record]);
});

it("discovers authorized declarative mounts and reveals the selected file", async () => {
  const actions = await discoverMountedFileActions("ssh-1", "/work/file.txt");
  expect(actions).toHaveLength(1);
  await revealMountedFile(actions[0]!, "ssh-1", "/work/file.txt");
  expect(mocks.invoke).toHaveBeenLastCalledWith("plugin_mounts_action", {
    pluginId: owner.id,
    method: "reveal",
    params: { id: record.id, sessionId: "ssh-1", path: "/work/file.txt" },
  });
});

it("ignores a grant revoked while discovery is pending and never opens stale actions", async () => {
  let finish!: (value: unknown) => void;
  mocks.invoke.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const pending = discoverMountedFileActions("ssh-1", "/work/file.txt");
  usePluginSecurity.setState((state) => ({ state: { ...state.state, grants: {} } }));
  finish([record]);
  expect(await pending).toEqual([]);
  await revealMountedFile(
    { pluginId: owner.id, pluginName: owner.name, fingerprint: owner.fingerprint, mount: record },
    "ssh-1",
    "/work/file.txt",
  );
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
});

it("does not infer a contribution from permissions alone", async () => {
  usePlugins.setState({ items: [{ ...owner, mountedFileReveal: false }] });
  expect(await discoverMountedFileActions("ssh-1", "/work/file.txt")).toEqual([]);
  expect(mocks.invoke).not.toHaveBeenCalled();
});

it("does not execute an action after the contribution is removed", async () => {
  const actions = await discoverMountedFileActions("ssh-1", "/work/file.txt");
  usePlugins.setState({ items: [{ ...owner, mountedFileReveal: false }] });
  await revealMountedFile(actions[0]!, "ssh-1", "/work/file.txt");
  expect(mocks.invoke).toHaveBeenCalledTimes(1);
  expect(useToasts.getState().items.at(-1)?.variant).toBe("error");
});

it("publishes a fast result without waiting for an unrelated slow plugin", async () => {
  const slow = { ...owner, id: "slow", fingerprint: "slow" };
  usePlugins.setState({ items: [slow, owner] });
  usePluginSecurity.setState((state) => ({
    state: { ...state.state, grants: { ...state.state.grants, slow: slow.permissions } },
  }));
  let finishSlow!: (value: unknown) => void;
  mocks.invoke.mockImplementation((_command, args) =>
    args.pluginId === "slow"
      ? new Promise((resolve) => {
          finishSlow = resolve;
        })
      : Promise.resolve([record]),
  );
  const onAction = vi.fn();
  const pending = discoverMountedFileActions("ssh-1", "/work/file.txt", onAction);
  await vi.waitFor(() => expect(onAction).toHaveBeenCalledOnce());
  expect(onAction.mock.calls[0]![0].pluginId).toBe(owner.id);
  finishSlow([]);
  expect(await pending).toHaveLength(1);
});
