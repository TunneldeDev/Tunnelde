import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTransferWindowActions } from "@/features/sftp/transferWindowActions";
import { createTaskProjection, useTaskProjection } from "@/lib/panels/taskProjection";
import { registerBackgroundTaskSource } from "@/lib/tasks/registry";
import { transferView } from "@/features/sftp/transferView";
import type {
  TransferPromptOperation,
  TransferResumeResult,
  TransferWindowAction,
} from "@/features/sftp/transferWindowProtocol";
import { useTransfers, type TransferItem } from "@/store/transfers";
import { useSsh } from "@/store/ssh";
import { useHosts } from "@/store/hosts";
import { usePanelWindows } from "@/store/panelWindows";
import { useWorkspace } from "@/store/workspace";
import { api } from "@/lib/api/ipc";
import { transferApi } from "@/lib/api/transfers";
import type { Host, SshSession } from "@/lib/api/types";
const mock = vi.hoisted(() => ({
  prepare: vi.fn(),
  probe: vi.fn(),
  trust: vi.fn(),
  connect: vi.fn(),
  test: vi.fn(),
  installKey: vi.fn(),
  credential: vi.fn(),
  create: vi.fn(),
}));
vi.mock("@/lib/api/connections/review", () => ({
  createReviewedConnection: (host: Host) => {
    mock.create(host);
    return {
      key: "review-key",
      prepare: mock.prepare,
      probe: mock.probe,
      trust: mock.trust,
      connect: mock.connect,
      test: mock.test,
      installKey: mock.installKey,
      credential: mock.credential,
    };
  },
}));
const cleanup: (() => void)[] = [];
const lease = { panelId: "tasks", windowId: "satellite", generation: 3 };
const host = {
  id: "h",
  name: "Remote",
  host: "example",
  port: 22,
  username: "qa",
  authMethod: "password",
  keyPath: "never-key-path",
} as Host;
const session = { id: "s", hostId: "h", address: "qa@example:22", title: "Remote" } as SshSession;
const initial: TransferItem = {
  id: "job",
  name: "a.txt",
  direction: "transfer",
  status: "paused",
  error: null,
  updatedAt: 1,
  durable: true,
  transferred: 5,
  total: 100,
  fromHostId: null,
  fromSession: null,
  fromPath: "/source/a.txt",
  toHostId: "h",
  toSession: "old-session",
  toAddress: "qa@example:22",
  toPath: "/dest/a.txt",
};
beforeEach(() => {
  vi.clearAllMocks();
  useTransfers.setState({ items: [{ ...initial }] });
  useSsh.setState({ sessions: [] });
  useHosts.setState({ hosts: [host] });
  usePanelWindows.setState({ snapshot: { windows: [], panels: [lease], transfers: [] } });
  mock.prepare.mockResolvedValue({
    jumpHosts: [],
    review: { hostId: "h", revision: "never-review-token" },
  });
  mock.probe.mockResolvedValue({ status: "known", fingerprint: "key" });
  mock.trust.mockResolvedValue({ status: "known", fingerprint: "key" });
  mock.credential.mockResolvedValue(undefined);
  mock.test.mockResolvedValue(null);
  mock.connect.mockResolvedValue(session);
  mock.installKey.mockResolvedValue({ keyPath: "never-installed-key-path" });
  vi.spyOn(api, "credentialStatus").mockResolvedValue(true);
  vi.spyOn(api, "sshCancelTest").mockResolvedValue(undefined);
  vi.spyOn(transferApi, "resume").mockResolvedValue(undefined);
  vi.spyOn(transferApi, "pause").mockResolvedValue(undefined);
  vi.spyOn(transferApi, "clear").mockResolvedValue(null);
  vi.spyOn(api, "transferCancel").mockResolvedValue(undefined);
});
afterEach(() => {
  for (const stop of cleanup.splice(0).reverse()) stop();
  vi.restoreAllMocks();
});
function setup() {
  cleanup.push(
    registerBackgroundTaskSource({
      id: "transfers",
      subscribe: (fn) => useTransfers.subscribe(fn),
      snapshot: () =>
        useTransfers.getState().items.map((item) => ({
          id: item.id,
          title: item.name,
          status:
            item.status === "failed" || item.status === "cleanupPending"
              ? "attention"
              : item.status,
          execution: "native",
          updatedAt: item.updatedAt,
        })),
    }),
  );
  const projection = createTaskProjection();
  cleanup.push(projection.dispose);
  const show = vi.fn().mockResolvedValue(undefined);
  const actions = createTransferWindowActions(projection, show);
  cleanup.push(actions.dispose);
  const entry = () => useTaskProjection.getState().items[0]!;
  const execute = (
    command: Extract<TransferWindowAction, { kind: "transfer" }>["command"],
    current = entry(),
  ) =>
    actions.execute(lease, { kind: "transfer", key: current.key, ticket: current.ticket, command });
  const resume = (current = entry()) =>
    actions.execute(lease, {
      kind: "transferResume",
      key: current.key,
      ticket: current.ticket,
      interaction: "guard",
    }) as Promise<TransferResumeResult>;
  const prompt = (handle: string, command: TransferPromptOperation, owner = lease) =>
    actions.execute(owner, {
      kind: "transferPrompt",
      key: entry().key,
      ticket: entry().ticket,
      interaction: "guard",
      handle,
      command,
    });
  return { ...actions, entry, show, execute, resume, prompt };
}
it("whitelists presentation data, retains tickets through progress, and retires retargeted endpoints", async () => {
  useTransfers.setState({
    items: [
      {
        ...initial,
        password: "never-secret",
        rate: {
          baseline: 0,
          samples: [{ at: 1, bytes: 5, secret: "never-secret" }],
          secret: "never-secret",
        },
      } as unknown as TransferItem,
    ],
  });
  const f = setup(),
    old = f.entry();
  expect(JSON.stringify(old.transfer)).not.toContain("never-");
  expect(old.transfer?.item).not.toHaveProperty("toSession");
  expect(old.transfer?.item).not.toHaveProperty("toHostId");
  expect(old.transfer?.inspect).toEqual(["from"]);
  useTransfers.setState({ items: [{ ...initial, transferred: 10 }] });
  expect(f.entry().ticket).toBe(old.ticket);
  useSsh.setState({ sessions: [session] });
  expect(f.entry().transfer?.inspect).toEqual(["from", "to"]);
  expect(f.entry().ticket).toBe(old.ticket);
  useTransfers.setState({ items: [{ ...initial, toAddress: "qa@other:22" }] });
  expect(f.entry().ticket).not.toBe(old.ticket);
  await expect(f.resume(old)).rejects.toThrow("changed");
  expect(mock.create).not.toHaveBeenCalled();
});
it("does not reconnect on render/projection; resume returns only a bounded private host prompt", async () => {
  const f = setup();
  expect(mock.create).not.toHaveBeenCalled();
  expect(mock.prepare).not.toHaveBeenCalled();
  const result = await f.resume();
  expect(result.prompt?.host).toEqual({
    id: "h",
    name: "Remote",
    host: "example",
    port: 22,
    username: "qa",
    authMethod: "password",
  });
  expect(JSON.stringify(result)).not.toContain("never-");
  expect(mock.prepare).not.toHaveBeenCalled();
  expect(transferApi.resume).not.toHaveBeenCalled();
  await expect(f.resume()).rejects.toThrow("actionUnavailable");
});
it("uses one coordinator-reviewed background acquisition, then re-resolves both transfer endpoints", async () => {
  const f = setup(),
    { prompt } = await f.resume();
  const handle = prompt!.handle;
  const connect = vi
    .spyOn(useSsh.getState(), "connect")
    .mockImplementation(async (request, _, acquisition) => {
      const next = await acquisition!.connect(request);
      useSsh.setState({ sessions: [next] });
      return next;
    });
  await f.prompt(handle, {
    operation: "connect",
    password: "private-password",
    passphrase: null,
    credentials: {},
  });
  expect(connect).toHaveBeenCalledWith(
    expect.objectContaining({ hostId: "h", background: true, password: "private-password" }),
    expect.any(Function),
    { key: "review-key", connect: mock.connect },
  );
  expect(transferApi.resume).not.toHaveBeenCalled();
  await f.prompt(handle, { operation: "close" });
  expect(await f.resume()).toEqual({});
  expect(transferApi.resume).toHaveBeenCalledExactlyOnceWith("job");
});
it("rejects edited host targets and forwarding-only sessions rather than silently reusing them", async () => {
  const f = setup();
  useSsh.setState({ sessions: [{ ...session, purpose: "forwarding" }] });
  const prompt = (await f.resume()).prompt!;
  await f.prompt(prompt.handle, { operation: "close" });
  useHosts.setState({ hosts: [{ ...host, host: "changed" }] });
  await expect(f.resume()).rejects.toThrow("reconnectRequired");
  expect(transferApi.resume).not.toHaveBeenCalled();
});
it("rechecks location identity at click time; unknown remotes never become local or accept arbitrary paths", async () => {
  const f = setup(),
    open = vi.spyOn(useWorkspace.getState(), "openFilePane").mockReturnValue("");
  await expect(f.execute({ operation: "inspect", location: "to" })).rejects.toThrow(
    "reconnectRequired",
  );
  expect(open).not.toHaveBeenCalled();
  useSsh.setState({ sessions: [session] });
  await f.execute({ operation: "inspect", location: "to" });
  expect(open).toHaveBeenCalledWith(
    expect.objectContaining({ path: "/dest", source: { kind: "remote", sessionId: "s" } }),
    "Remote",
  );
  expect(f.show).toHaveBeenCalledOnce();
  useSsh.setState({ sessions: [{ ...session, address: "qa@other:22" }] });
  await expect(f.execute({ operation: "inspect", location: "to" })).rejects.toThrow(
    "reconnectRequired",
  );
  expect(open).toHaveBeenCalledOnce();
});
it("shares backup/artifact inspection without transport callbacks or arbitrary path commands", () => {
  const item = {
    ...initial,
    backupRecovery: { backup: "/b", destination: "/d" },
    artifactRecovery: "/a",
  };
  expect(transferView(item, [session]).inspect).toEqual([
    "from",
    "to",
    "backup",
    "backupDestination",
    "artifact",
  ]);
  expect(transferView(item, []).inspect).toEqual(["from"]);
});
it("rejects other owner/consent handles and arbitrary keychain, trust or hop targets", async () => {
  const f = setup(),
    { prompt } = await f.resume(),
    handle = prompt!.handle;
  await expect(
    f.prompt(handle, { operation: "prepare" }, { ...lease, generation: 4 }),
  ).rejects.toThrow("staleOwner");
  await expect(
    f.prompt(handle, { operation: "credential", hostId: "unrelated", password: "secret" }),
  ).rejects.toThrow("connectionChanged");
  await expect(
    f.prompt(handle, {
      operation: "trust",
      expectedHostId: "unrelated",
      fingerprint: "key",
      credentials: {},
    }),
  ).rejects.toThrow("connectionChanged");
  await expect(
    f.prompt(handle, { operation: "probe", credentials: { unrelated: { password: "secret" } } }),
  ).rejects.toThrow("connectionChanged");
  expect(mock.credential).not.toHaveBeenCalled();
  expect(mock.trust).not.toHaveBeenCalled();
  expect(mock.probe).not.toHaveBeenCalled();
});
it("returns only display hosts/status booleans from plan, and discards installed key paths", async () => {
  const f = setup(),
    { prompt } = await f.resume(),
    handle = prompt!.handle;
  mock.prepare.mockResolvedValue({ jumpHosts: [{ ...host, id: "jump" }] });
  const plan = await f.prompt(handle, { operation: "prepare" });
  expect(plan).toMatchObject({
    saved: { h: true, jump: true },
    jumpHosts: [{ id: "jump", host: "example" }],
  });
  expect(JSON.stringify(plan)).not.toContain("never-");
  vi.spyOn(useHosts.getState(), "load").mockResolvedValue(true);
  expect(
    await f.prompt(handle, { operation: "installKey", password: "private", credentials: {} }),
  ).toBeNull();
});
it("namespaces and cancels only prompt-owned quality tests, and cleans them on owner loss", async () => {
  const f = setup(),
    { prompt } = await f.resume(),
    handle = prompt!.handle;
  let finish!: (value: null) => void;
  mock.test.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const testing = f.prompt(handle, { operation: "test", id: "quality", credentials: {} });
  for (let i = 0; i < 20; i++) await Promise.resolve();
  const nativeId = mock.test.mock.calls[0]![0] as string;
  expect(nativeId).toMatch(/^[a-f0-9-]{36}$/);
  expect(nativeId).not.toBe("quality");
  expect(mock.test).toHaveBeenCalledWith(nativeId, {});
  await f.prompt(handle, { operation: "cancelTest", id: "unrelated" });
  expect(api.sshCancelTest).not.toHaveBeenCalled();
  usePanelWindows.setState({
    snapshot: { windows: [], panels: [{ ...lease, generation: 4 }], transfers: [] },
  });
  expect(api.sshCancelTest).toHaveBeenCalledExactlyOnceWith(nativeId);
  finish(null);
  await testing;
  await expect(f.prompt(handle, { operation: "probe", credentials: {} })).rejects.toThrow(
    "staleOwner",
  );
});
it("retires handles on source loss, task loss, or timeout without replaying effects", async () => {
  vi.useFakeTimers();
  try {
    const f = setup(),
      { prompt } = await f.resume(),
      handle = prompt!.handle;
    vi.advanceTimersByTime(330_000);
    await expect(f.prompt(handle, { operation: "probe", credentials: {} })).rejects.toThrow(
      "staleOwner",
    );
    const next = (await f.resume()).prompt!;
    useTransfers.setState({ items: [] });
    useTransfers.setState({ items: [{ ...initial }] });
    await expect(f.prompt(next.handle, { operation: "probe", credentials: {} })).rejects.toThrow(
      "staleOwner",
    );
    expect(mock.probe).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});
it("retained unknown receipts settle without network work and cleanup reconnects only destination", async () => {
  const f = setup();
  useTransfers.setState({
    items: [
      {
        ...initial,
        retainedCreation: true,
        retainedSettlement: "unknown",
        status: "failed",
        error: "sftp.transferArtifactUnrecognized",
      },
    ],
  });
  // Review-only artifact outcomes remain explicit clear/inspection, never Resume.
  await expect(f.resume()).rejects.toThrow("actionUnavailable");
  useTransfers.setState({
    items: [
      { ...initial, retainedCreation: true, retainedSettlement: "unknown", status: "failed" },
    ],
  });
  expect(await f.resume()).toEqual({});
  expect(transferApi.clear).toHaveBeenCalledOnce();
  expect(mock.create).not.toHaveBeenCalled();
  useTransfers.setState({
    items: [
      {
        ...initial,
        status: "cleanupPending",
        fromHostId: "missing",
        fromSession: "old",
        fromAddress: "old@missing:22",
      },
    ],
  });
  expect((await f.resume()).prompt?.host.id).toBe("h");
});
it("awaits backend pause/cancel admission, rejects duplicate controls and returns errors to the origin", async () => {
  useTransfers.setState({ items: [{ ...initial, status: "running" }] });
  const f = setup();
  let reject!: (error: Error) => void;
  vi.mocked(transferApi.pause).mockImplementation(
    () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  );
  let completed = false;
  const pausing = f.execute({ operation: "pause" }).then(() => {
    completed = true;
  });
  expect(completed).toBe(false);
  await expect(f.execute({ operation: "cancel" })).rejects.toThrow("actionUnavailable");
  const check = expect(pausing).rejects.toThrow("origin error");
  reject(new Error("origin error"));
  await check;
  expect(useTransfers.getState().items[0]?.pausing).toBe(false);
  await f.execute({ operation: "cancel" });
  expect(api.transferCancel).toHaveBeenCalledOnce();
});
it("retains bounded owner-local early cancellation without ever using caller-chosen native diagnostic IDs", async () => {
  const f = setup(),
    { prompt } = await f.resume(),
    handle = prompt!.handle;
  await f.prompt(handle, { operation: "cancelTest", id: "early" });
  await expect(
    f.prompt(handle, { operation: "test", id: "early", credentials: {} }),
  ).rejects.toThrow("testCancelled");
  expect(mock.test).not.toHaveBeenCalled();
  expect(api.sshCancelTest).not.toHaveBeenCalled();
});
it("registers diagnostic identity before asynchronous preparation so cancel cannot miss an admitted test", async () => {
  const f = setup(),
    { prompt } = await f.resume(),
    handle = prompt!.handle;
  let ready!: (plan: { jumpHosts: Host[] }) => void;
  mock.prepare.mockImplementation(
    () =>
      new Promise((resolve) => {
        ready = resolve;
      }),
  );
  const testing = f.prompt(handle, { operation: "test", id: "pending", credentials: {} });
  await f.prompt(handle, { operation: "cancelTest", id: "pending" });
  const id = vi.mocked(api.sshCancelTest).mock.calls[0]![0];
  expect(id).toMatch(/^[a-f0-9-]{36}$/);
  ready({ jumpHosts: [] });
  await testing;
  expect(mock.test).toHaveBeenCalledWith(id, {});
});
