import { afterEach, beforeEach, expect, it, vi } from "vitest";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@/lib/api/ipc", () => ({ isTauri: () => true }));
import {
  createForwardingReadSource,
  forwardingReadData,
} from "@/features/forwarding/data/readSource";
import { forwardingStore } from "@/features/forwarding/data/store";
import { forwardingGroupsStore } from "@/features/forwarding/data/groups";
import { useHosts } from "@/store/hosts";
import { useSsh } from "@/store/ssh";
import { usePanelWindows } from "@/store/panelWindows";
import type { Host, SshSession } from "@/lib/api/types";
import type { ForwardInfo } from "@/features/forwarding/model/contract";
import { domainEvents } from "@/lib/events/domain";
import "@/i18n/i18n";
const original = {
  hosts: useHosts.getState(),
  ssh: useSsh.getState(),
  windows: usePanelWindows.getState(),
};
const cleanups: (() => void)[] = [];
const settle = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
beforeEach(() => {
  invoke.mockReset().mockResolvedValue([]);
  usePanelWindows.setState({ windowId: "main" });
  useHosts.setState({ hosts: [], loaded: false, loading: true });
  useSsh.setState({ sessions: [] });
});
afterEach(() => {
  for (const stop of cleanups.splice(0).reverse()) stop();
  useHosts.setState(original.hosts, true);
  useSsh.setState(original.ssh, true);
  usePanelWindows.setState(original.windows, true);
  forwardingStore.reset();
  forwardingGroupsStore.reset();
});
const source = () => {
  const value = createForwardingReadSource();
  cleanups.push(() => value.dispose());
  return value;
};
const row = (): ForwardInfo => ({
  id: "rule",
  hostId: "host",
  name: "Forward",
  mode: "local",
  bindHost: "127.0.0.1",
  bindPort: 8080,
  targetHost: "localhost",
  targetPort: 80,
  revision: "one",
  active: false,
  sessionId: null,
});

it("projects only declared display fields including empty groups and stringified errors", () => {
  useHosts.setState({
    hosts: [
      {
        id: "host",
        name: "Host",
        host: "server",
        port: 22,
        username: "user",
        authMethod: "key",
        source: { pluginId: "private-source" },
        keyPath: "never-key-path",
        password: "never-password",
        note: "never-note",
        credential: "never-reference",
      },
    ] as unknown as Host[],
    loading: true,
    loaded: true,
  });
  useSsh.setState({
    sessions: [
      {
        id: "session",
        hostId: "host",
        purpose: "forwarding",
        address: "never-session-address",
        history: "never-history",
      },
    ] as unknown as SshSession[],
  });
  forwardingStore.accept(() => [
    {
      ...row(),
      providerToken: "never-token",
      automation: { autoStart: true, autoRetry: false, secret: "never-options" },
      automationStatus: {
        phase: "needsAttention",
        retryAt: null,
        error: {
          code: "validation",
          message: "forward.changed",
          details: { token: "never-error-details" },
        },
      },
    } as ForwardInfo,
  ]);
  forwardingGroupsStore.accept(() => [
    {
      id: "empty",
      hostId: "host",
      name: "Empty group",
      revision: "one",
      privateState: "never-group-authority",
    },
  ]);
  const projected = forwardingReadData();
  expect(projected.hosts).toEqual([
    {
      id: "host",
      name: "Host",
      host: "server",
      port: 22,
      username: "user",
      authMethod: "key",
      source: true,
    },
  ]);
  expect(projected.hostsLoading).toBe(false);
  expect(projected.sessions).toEqual([{ id: "session", hostId: "host", purpose: "forwarding" }]);
  expect(projected.groups.entries).toEqual([
    { id: "empty", hostId: "host", name: "Empty group", revision: "one" },
  ]);
  expect(projected.rules.entries?.[0]?.automationStatus?.error).toEqual(expect.any(String));
  expect(JSON.stringify(projected)).not.toMatch(/never-|private-source/);
});

it("does not start I/O for passive publisher subscriptions and shares local readers across retained projections", async () => {
  const value = source();
  const receive = vi.fn();
  cleanups.push(value.store.subscribe(receive));
  value.snapshot();
  expect(invoke).not.toHaveBeenCalled();
  const localRule = forwardingStore.subscribe(vi.fn()),
    localGroup = forwardingGroupsStore.subscribe(vi.fn());
  cleanups.push(localRule, localGroup);
  const first = value.retain(),
    second = value.retain();
  cleanups.push(first, second);
  await settle();
  expect(invoke.mock.calls.map(([command]) => command).sort()).toEqual([
    "forwarding_groups_list",
    "forwarding_list",
  ]);
  first();
  first();
  domainEvents.forwardsChanged();
  await settle();
  expect(invoke).toHaveBeenCalledTimes(4);
  second();
  // The local consumer still owns the reader; retiring the remote projection
  // must not clear the shared committed list under that local consumer.
  expect(forwardingStore.getSnapshot().entries).toEqual([]);
  expect(forwardingGroupsStore.getSnapshot().entries).toEqual([]);
  localRule();
  localGroup();
  const third = value.retain();
  cleanups.push(third);
  await settle();
  expect(invoke).toHaveBeenCalledTimes(6);
});

it("retains live host/session changes without publishing unrelated writable metadata", async () => {
  const value = source();
  cleanups.push(value.retain());
  await settle();
  useHosts.setState({
    hosts: [
      {
        id: "new",
        name: "New",
        host: "server",
        port: 22,
        username: "user",
        authMethod: "agent",
        keyPath: "never-key",
      },
    ] as Host[],
    loaded: true,
    loading: false,
  });
  useSsh.setState({
    sessions: [{ id: "live", hostId: "new", purpose: "forwarding" }] as SshSession[],
  });
  expect(value.snapshot()).toMatchObject({
    hosts: [{ id: "new" }],
    hostsLoading: false,
    sessions: [{ id: "live" }],
  });
  expect(JSON.stringify(value.snapshot())).not.toContain("never-key");
});

it("clears abandoned native reader lifetimes and ignores their late completions after re-retain", async () => {
  const pending: Array<(value: unknown[]) => void> = [];
  invoke.mockImplementation(() => new Promise((resolve) => pending.push(resolve)));
  const value = source();
  const first = value.retain();
  first();
  const second = value.retain();
  cleanups.push(second);
  pending[0]!([row()]);
  pending[1]!([{ id: "old", hostId: "host", name: "Old", revision: "one" }]);
  await settle();
  expect(value.snapshot().rules.entries).toBeNull();
  expect(value.snapshot().groups.entries).toBeNull();
  pending[2]!([{ ...row(), name: "Current" }]);
  pending[3]!([]);
  await settle();
  expect(value.snapshot().rules.entries?.[0]?.name).toBe("Current");
  expect(value.snapshot().groups.entries).toEqual([]);
});

it("keeps committed rows after a failed refresh and projects a recoverable error message", async () => {
  let fail = false;
  invoke.mockImplementation(async (command) => {
    if (command === "forwarding_list" && fail) throw new Error("read unavailable");
    return command === "forwarding_list" ? [row()] : [];
  });
  const value = source();
  cleanups.push(value.retain());
  await settle();
  fail = true;
  domainEvents.forwardsChanged();
  await settle();
  expect(value.snapshot().rules).toMatchObject({
    entries: [{ id: "rule" }],
    busy: false,
    error: "read unavailable",
  });
  fail = false;
  domainEvents.forwardsChanged();
  await settle();
  expect(value.snapshot().rules.error).toBeNull();
});

it("refuses satellite retention and releases every observer on disposal", async () => {
  const value = source();
  usePanelWindows.setState({ windowId: "satellite" });
  expect(() => value.retain()).toThrow("panel.window.coordinatorRequired");
  expect(invoke).not.toHaveBeenCalled();
  usePanelWindows.setState({ windowId: "main" });
  const release = value.retain();
  await settle();
  value.dispose();
  const count = invoke.mock.calls.length;
  domainEvents.forwardsChanged();
  await settle();
  expect(invoke).toHaveBeenCalledTimes(count);
  expect(() => value.retain()).toThrow("panel.window.disposed");
  release();
  release();
});
