import { afterEach, beforeEach, expect, it, vi } from "vitest";
const { invoke, copy } = vi.hoisted(() => ({ invoke: vi.fn(), copy: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@/lib/session/clipboard", () => ({ copyText: copy }));
import { localForwardingActions as actions } from "@/features/forwarding/runtime/actions";
import { forwardingStore } from "@/features/forwarding/data/store";
import { forwardingGroupsStore } from "@/features/forwarding/data/groups";
import type { ForwardingAuthority } from "@/lib/extensions/forwarding/authority";
import type { ForwardGroup, ForwardInfo } from "@/features/forwarding/model/contract";
import { useSsh } from "@/store/ssh";
import { usePanelWindows } from "@/store/panelWindows";
import type { SshSession } from "@/lib/api/types";

const row = (): ForwardInfo => ({
  id: "rule",
  hostId: "host",
  name: "forward",
  mode: "local",
  bindHost: "127.0.0.1",
  bindPort: 8080,
  targetHost: "localhost",
  targetPort: 80,
  groupId: "group",
  revision: "one",
  automation: { autoStart: true, autoRetry: true },
  active: true,
  sessionId: "session",
  runtimeId: "runtime",
});
const group: ForwardGroup = { id: "group", hostId: "host", name: "Group", revision: "one" };
const session = { id: "session", hostId: "host", purpose: "forwarding" } as SshSession;
const previous = useSsh.getState();
const windows = usePanelWindows.getState();
beforeEach(() => {
  invoke.mockReset().mockResolvedValue(undefined);
  copy.mockReset().mockResolvedValue(undefined);
  usePanelWindows.setState({ windowId: "main" });
  useSsh.setState({ sessions: [session] });
});
afterEach(() => {
  vi.restoreAllMocks();
  usePanelWindows.setState(windows, true);
  useSsh.setState(previous, true);
  forwardingStore.reset();
  forwardingGroupsStore.reset();
});

it("captures editable saves before yielding and publishes only the committed response", async () => {
  const target = row();
  let open!: (value: { token: string; scope: string }) => void;
  const authority = {
    origin: () =>
      new Promise((resolve) => {
        open = resolve;
      }),
    authorize: vi.fn(),
  } as ForwardingAuthority;
  const saved = { ...row(), revision: "two" };
  invoke.mockResolvedValue(saved);
  const pending = actions.save(target, target.revision, authority);
  target.name = "later edit";
  target.groupId = "later-group";
  target.automation!.autoRetry = false;
  open({ token: "provider-token", scope: "provider-scope" });
  expect(await pending).toBe(saved);
  expect(authority.authorize).toHaveBeenCalledOnce();
  expect(invoke).toHaveBeenCalledWith("forwarding_save", {
    rule: {
      id: "rule",
      hostId: "host",
      name: "forward",
      mode: "local",
      bindHost: "127.0.0.1",
      bindPort: 8080,
      targetHost: "localhost",
      targetPort: 80,
    },
    groupId: "group",
    assignGroup: true,
    automation: { autoStart: true, autoRetry: true },
    expectedRevision: "one",
    origin: { token: "provider-token", scope: "provider-scope" },
  });
  expect(forwardingStore.getSnapshot().entries?.[0]).toMatchObject({
    revision: "two",
    active: false,
    sessionId: null,
  });
});

it("never retries revoked provider mutations as built-in authority", async () => {
  const authority: ForwardingAuthority = {
    origin: vi.fn(async () => ({ token: "t", scope: "s" })),
    authorize: () => {
      throw new Error("revoked");
    },
  };
  for (const perform of [
    () => actions.save(row(), "one", authority),
    () => actions.start(row(), authority),
    () => actions.remove(row(), authority),
    () => actions.stop(row(), authority),
    () => actions.disconnect("host", "session", authority),
  ])
    await expect(perform()).rejects.toThrow("revoked");
  expect(invoke).not.toHaveBeenCalled();
});

it("binds start target, credentials and review before provider acquisition and accepts the resulting session once", async () => {
  const target = row();
  const request = {
    hostId: "host",
    password: "ephemeral",
    jumpCredentials: { jump: { password: "jump-once" } },
  };
  const review = { hostId: "host", revision: "review" };
  let open!: (value: { token: string; scope: string }) => void;
  const authority = {
    origin: () =>
      new Promise((resolve) => {
        open = resolve;
      }),
    authorize: vi.fn(),
  } as ForwardingAuthority;
  const accept = vi.spyOn(useSsh.getState(), "acceptSession");
  invoke.mockResolvedValue(session);
  const pending = actions.start(target, authority, request, review);
  target.id = "replacement";
  target.revision = "later";
  request.password = "changed";
  request.jumpCredentials.jump.password = "changed";
  review.revision = "changed";
  open({ token: "t", scope: "s" });
  expect(await pending).toBe(session);
  expect(invoke).toHaveBeenCalledWith("forwarding_start_managed", {
    id: "rule",
    expectedRevision: "one",
    request: {
      hostId: "host",
      password: "ephemeral",
      jumpCredentials: { jump: { password: "jump-once" } },
    },
    review: { hostId: "host", revision: "review" },
    origin: { token: "t", scope: "s" },
  });
  expect(accept).toHaveBeenCalledExactlyOnceWith(session);
});

it("keeps remove and provider stop tied to their captured revision and runtime", async () => {
  const target = row();
  let open!: (value: { token: string; scope: string }) => void;
  const authority = {
    origin: () =>
      new Promise((resolve) => {
        open = resolve;
      }),
    authorize: vi.fn(),
  } as ForwardingAuthority;
  const removing = actions.remove(target, authority);
  target.id = "other";
  target.revision = "two";
  open({ token: "t", scope: "s" });
  await removing;
  expect(invoke).toHaveBeenLastCalledWith("forwarding_remove", {
    id: "rule",
    expectedRevision: "one",
    origin: { token: "t", scope: "s" },
  });
  const stopping = actions.stop(target, authority);
  target.id = "third";
  target.runtimeId = "replacement";
  open({ token: "t", scope: "s" });
  await stopping;
  expect(invoke).toHaveBeenLastCalledWith("forwarding_stop", {
    id: "other",
    expectedRevision: "two",
    runtimeId: "runtime",
    origin: { token: "t", scope: "s" },
  });
});

it("does not publish a failed save and requires existing rule revisions", async () => {
  await expect(actions.save(row())).rejects.toThrow("forward.changed");
  expect(invoke).not.toHaveBeenCalled();
  invoke.mockRejectedValue(new Error("forward.changed"));
  await expect(actions.save(row(), "one")).rejects.toThrow("forward.changed");
  expect(forwardingStore.getSnapshot().entries).toBeNull();
});

it("disconnects only captured forwarding sessions and reports observed native failures", async () => {
  const disconnect = vi
    .spyOn(useSsh.getState(), "disconnect")
    .mockImplementation(async (_id, onError) => onError?.(new Error("disconnect failed")));
  await expect(actions.disconnect("wrong", "session")).rejects.toThrow("ssh.sessionMissing");
  useSsh.setState({ sessions: [{ ...session, purpose: "terminal" }] });
  await expect(actions.disconnect("host", "session")).rejects.toThrow("ssh.sessionMissing");
  expect(disconnect).not.toHaveBeenCalled();
  useSsh.setState({ sessions: [session] });
  await expect(actions.disconnect("host", "session")).rejects.toThrow("disconnect failed");
  useSsh.setState({ sessions: [] });
  await actions.disconnect("host", "session");
  expect(disconnect).toHaveBeenCalledOnce();
});

it("forgets provider sessions only after accepted cleanup and preserves them on failure", async () => {
  const authority: ForwardingAuthority = {
    origin: async () => ({ token: "t", scope: "s" }),
    authorize: vi.fn(),
  };
  invoke.mockRejectedValueOnce(new Error("cleanup failed"));
  await expect(actions.disconnect("host", "session", authority)).rejects.toThrow("cleanup failed");
  expect(useSsh.getState().sessions).toEqual([session]);
  invoke.mockResolvedValue(undefined);
  await actions.disconnect("host", "session", authority);
  expect(invoke).toHaveBeenLastCalledWith("forwarding_provider_disconnect", {
    sessionId: "session",
    origin: { token: "t", scope: "s" },
  });
  expect(useSsh.getState().sessions).toEqual([]);
});

it("routes group CAS and clipboard through the same service without runtime metadata", async () => {
  await actions.saveGroup("host", "new");
  expect(invoke).toHaveBeenLastCalledWith("forwarding_group_save", { hostId: "host", name: "new" });
  await actions.saveGroup("host", "rename", group);
  expect(invoke).toHaveBeenLastCalledWith("forwarding_group_save", {
    hostId: "host",
    name: "rename",
    id: "group",
    expectedRevision: "one",
  });
  await expect(actions.saveGroup("other", "rename", group)).rejects.toThrow("forward.changed");
  await actions.removeGroup(group);
  expect(invoke).toHaveBeenLastCalledWith("forwarding_group_remove", {
    id: "group",
    expectedRevision: "one",
  });
  await actions.copyAddress("localhost:8080");
  expect(copy).toHaveBeenCalledExactlyOnceWith("localhost:8080");
});

it("refuses every local service in a satellite, including the read refresh and clipboard", async () => {
  usePanelWindows.setState({ windowId: "satellite" });
  expect(() => actions.refresh()).toThrow("panel.window.coordinatorRequired");
  for (const perform of [
    () => actions.save(row(), "one"),
    () => actions.start(row()),
    () => actions.remove(row()),
    () => actions.stop(row()),
    () => actions.disconnect("host", "session"),
    () => actions.saveGroup("host", "new"),
    () => actions.removeGroup(group),
    () => actions.copyAddress("localhost"),
  ])
    await expect(perform()).rejects.toThrow("panel.window.coordinatorRequired");
  expect(invoke).not.toHaveBeenCalled();
  expect(copy).not.toHaveBeenCalled();
});

it("binds builtin stop to the captured revision and exact runtime or its absence", async () => {
  const target = row();
  const stopping = actions.stop(target);
  target.id = "replacement";
  target.revision = "two";
  target.runtimeId = "later";
  await stopping;
  expect(invoke).toHaveBeenLastCalledWith("forwarding_stop", {
    id: "rule",
    expectedRevision: "one",
    runtimeId: "runtime",
  });
  await actions.stop({ id: "retrying", revision: "three", runtimeId: null });
  expect(invoke).toHaveBeenLastCalledWith("forwarding_stop", {
    id: "retrying",
    expectedRevision: "three",
    runtimeId: null,
  });
  invoke.mockClear();
  await expect(actions.stop({ id: "rule", revision: "", runtimeId: "runtime" })).rejects.toThrow(
    "forward.changed",
  );
  const authority = { origin: vi.fn(), authorize: vi.fn() } as unknown as ForwardingAuthority;
  await expect(actions.stop({ id: "rule", revision: "one" }, authority)).rejects.toThrow(
    "forward.changed",
  );
  expect(authority.origin).not.toHaveBeenCalled();
  expect(invoke).not.toHaveBeenCalled();
});
