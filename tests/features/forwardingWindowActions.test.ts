import { afterEach, expect, it, vi } from "vitest";
import { createWindowForwardingActions } from "@/features/forwarding/runtime/windowActions";
import type { PanelWindowClient } from "@/lib/panels/windowClient";
import type { PanelWindowCommand } from "@/lib/panels/windowProtocol";
import type { ForwardingWindowMutation } from "@/features/forwarding/runtime/windowProtocol";
import type { NativeForwardingPromptClient } from "@/features/forwarding/runtime/windowPrompt";
const raw = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: raw.invoke }));
afterEach(() => {
  expect(raw.invoke).not.toHaveBeenCalled();
  vi.clearAllMocks();
});
const lease = { panelId: "forwarding", windowId: "satellite", generation: 3 };
const rule = {
  id: "rule",
  revision: "r1",
  hostId: "host",
  name: "Test",
  mode: "local" as const,
  bindHost: "127.0.0.1",
  bindPort: 8080,
  targetHost: "localhost",
  targetPort: 80,
  groupId: "group",
  automation: { autoStart: true, autoRetry: false },
  runtimeId: "runtime",
};
const host = {
  id: "host",
  name: "Host",
  host: "example",
  port: 22,
  username: "qa",
  authMethod: "password" as const,
};
const plan = { host, jumpHosts: [], review: { hostId: "host", revision: "a".repeat(64) } };
function fixture() {
  const control = vi.fn(async (r: PanelWindowCommand): Promise<unknown> =>
    r.action === "beginInteraction" ? "original" : null,
  );
  const mutation = vi.fn(async (_lease: unknown, r: ForwardingWindowMutation): Promise<unknown> =>
    r.operation === "prepareStart"
      ? structuredClone(plan)
      : r.operation === "start"
        ? { id: "ssh", hostId: "host" }
        : structuredClone(rule),
  );
  const client = { control, forwardingMutation: mutation } as unknown as PanelWindowClient;
  const refresh = vi.fn(),
    check = vi.fn();
  const service = createWindowForwardingActions(client, lease, { check, refresh, report: vi.fn() });
  const providerMutation = vi.fn(
    async (_token: string, _lease: unknown, r: ForwardingWindowMutation) => mutation(_lease, r),
  );
  const providerCheck = vi.fn();
  const authority = service.createProviderAuthority({
    hostId: "host",
    token: "native-original",
    client: { forwardingMutation: providerMutation } as unknown as NativeForwardingPromptClient,
    check: providerCheck,
  });
  return {
    service,
    control,
    mutation,
    client,
    refresh,
    check,
    providerMutation,
    providerCheck,
    authority,
  };
}
it("composes every closed builtin mutation using exact native lease, original confirmations and runtime IDs", async () => {
  const f = fixture(),
    a = f.service.actions;
  a.refresh();
  expect(f.refresh).toHaveBeenCalledOnce();
  await a.save(rule, "r1", undefined, "exposure");
  await a.stop(rule);
  await a.remove(rule, undefined, "deletion");
  await a.disconnect("host", "ssh", undefined, "disconnect");
  const group = { id: "group", hostId: "host", revision: "g1", name: "Group" };
  await a.saveGroup("host", "Renamed", group);
  await a.removeGroup(group);
  await a.copyAddress("127.0.0.1:8080");
  expect(f.mutation.mock.calls.map(([, r]) => r.operation)).toEqual([
    "save",
    "stop",
    "remove",
    "disconnect",
    "saveGroup",
    "removeGroup",
    "copyAddress",
  ]);
  expect(f.mutation.mock.calls[0]?.[1]).toEqual({
    operation: "save",
    rule: {
      id: "rule",
      hostId: "host",
      name: "Test",
      mode: "local",
      bindHost: "127.0.0.1",
      bindPort: 8080,
      targetHost: "localhost",
      targetPort: 80,
    },
    revision: "r1",
    groupId: "group",
    automation: { autoStart: true, autoRetry: false },
    interaction: "exposure",
  });
  expect(f.mutation.mock.calls[1]?.[1]).toMatchObject({ runtimeId: "runtime", revision: "r1" });
  expect(
    f.mutation.mock.calls.every(([actual]) => JSON.stringify(actual) === JSON.stringify(lease)),
  ).toBe(true);
  expect(f.providerMutation).not.toHaveBeenCalled();
});
it("rejects missing original consent, foreign group and missing edit revision before native effects", async () => {
  const f = fixture();
  await expect(f.service.actions.remove(rule)).rejects.toThrow("staleOwner");
  await expect(f.service.actions.disconnect("host", "ssh")).rejects.toThrow("staleOwner");
  await expect(f.service.actions.save(rule)).rejects.toThrow("forward.changed");
  await expect(f.service.actions.save({ ...rule, automation: undefined }, "r1")).rejects.toThrow(
    "forward.changed",
  );
  await expect(
    f.service.actions.saveGroup("foreign", "Name", {
      id: "group",
      hostId: "host",
      revision: "g",
      name: "Group",
    }),
  ).rejects.toThrow("forward.changed");
  expect(f.mutation).not.toHaveBeenCalled();
});
it("uses original native provider continuation without calling origin or accepting copied/main/foreign service authority", async () => {
  const f = fixture();
  await f.service.actions.save(rule, "r1", f.authority);
  await f.service.actions.stop(rule, f.authority);
  await f.service.actions.remove(rule, f.authority, "delete");
  await f.service.actions.disconnect("host", "ssh", f.authority, "disconnect");
  expect(f.providerMutation).toHaveBeenCalledTimes(4);
  expect(f.providerMutation.mock.calls.every(([token]) => token === "native-original")).toBe(true);
  await expect(f.authority.origin()).rejects.toThrow("unsupportedView");
  const forged = { authorize: vi.fn(), origin: vi.fn() };
  for (const authority of [forged, { ...f.authority }, fixture().authority])
    await expect(f.service.actions.stop(rule, authority)).rejects.toThrow("expired");
  await expect(
    f.service.actions.save({ ...rule, hostId: "foreign" }, "r1", f.authority),
  ).rejects.toThrow("expired");
  expect(forged.authorize).not.toHaveBeenCalled();
  expect(forged.origin).not.toHaveBeenCalled();
  expect(f.providerMutation).toHaveBeenCalledTimes(4);
});
it("auto-start acquires and retires original native interaction and never relays main-dialog credentials/review", async () => {
  const f = fixture();
  await f.service.actions.start(rule, f.authority);
  expect(f.providerMutation.mock.calls.map(([, , r]) => r.operation)).toEqual([
    "prepareStart",
    "start",
  ]);
  expect(f.providerMutation.mock.calls.at(-1)?.[2]).toMatchObject({
    id: "rule",
    revision: "r1",
    interaction: "original",
    review: plan.review,
    credentials: { password: null, passphrase: null, jumps: {} },
  });
  expect(f.control).toHaveBeenLastCalledWith({ action: "endInteraction", lease, id: "original" });
  await expect(
    f.service.actions.start(
      rule,
      f.authority,
      { hostId: "host", cols: 80, rows: 24, password: "must-not-relay" },
      plan.review,
    ),
  ).rejects.toThrow("unsupportedView");
  expect(f.providerMutation).toHaveBeenCalledTimes(2);
});
it("rejects retained callbacks after disposal or provider revocation, without builtin fallback", async () => {
  const f = fixture();
  f.providerCheck.mockImplementation(() => {
    throw new Error("revoked");
  });
  await expect(f.service.actions.stop(rule, f.authority)).rejects.toThrow("revoked");
  expect(f.providerMutation).not.toHaveBeenCalled();
  expect(f.mutation).not.toHaveBeenCalled();
  f.service.dispose();
  await expect(f.service.actions.copyAddress("address")).rejects.toThrow("disposed");
  expect(() => f.service.actions.refresh()).toThrow("disposed");
});
it("keeps captured edits and native lease immutable across asynchronous delivery and rejects late completion after retirement", async () => {
  const f = fixture();
  let resolve!: (v: unknown) => void;
  f.mutation.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const edited = structuredClone(rule);
  const saving = f.service.actions.save(edited, "r1");
  edited.name = "Retargeted";
  edited.automation.autoStart = false;
  expect(f.mutation.mock.calls[0]?.[1]).toMatchObject({
    rule: { name: "Test" },
    automation: { autoStart: true },
  });
  f.service.dispose();
  resolve(rule);
  await expect(saving).rejects.toThrow("disposed");
});
it("cleans original interaction after authentication failure without starting a replacement connection", async () => {
  const f = fixture();
  f.mutation.mockImplementation(async (_lease, r) => {
    if (r.operation === "prepareStart") return plan;
    throw { code: "ssh", message: "ssh.passwordRequired" };
  });
  await expect(f.service.actions.start(rule)).rejects.toMatchObject({
    message: "ssh.passwordRequired",
  });
  expect(f.control).toHaveBeenLastCalledWith({ action: "endInteraction", lease, id: "original" });
  expect(f.providerMutation).not.toHaveBeenCalled();
});

it("retires late automatic-start consent on service disposal before any route preparation", async () => {
  const f = fixture();
  let resolve!: (value: unknown) => void;
  f.control.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const starting = expect(f.service.actions.start(rule)).rejects.toThrow("disposed");
  f.service.dispose();
  resolve("late-original");
  await starting;
  expect(f.mutation).not.toHaveBeenCalled();
  expect(f.control).toHaveBeenLastCalledWith({
    action: "endInteraction",
    lease,
    id: "late-original",
  });
  expect(f.control.mock.calls.filter(([r]) => r.action === "endInteraction")).toHaveLength(1);
});
