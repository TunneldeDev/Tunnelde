import { afterEach, expect, it, vi } from "vitest";
import { createForwardingWindowPrompt } from "@/features/forwarding/runtime/windowPrompt";
import type { PanelWindowClient } from "@/lib/panels/windowClient";
import type { PanelWindowCommand } from "@/lib/panels/windowProtocol";
import type { ForwardingWindowMutation } from "@/features/forwarding/runtime/windowProtocol";
const raw = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: raw.invoke }));
afterEach(() => {
  expect(raw.invoke).not.toHaveBeenCalled();
  vi.clearAllMocks();
});
function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
const lease = { panelId: "forwarding", windowId: "satellite", generation: 4 };
const target = { id: "rule", revision: "displayed", hostId: "host" };
const host = {
  id: "host",
  name: "Target",
  host: "example",
  port: 22,
  username: "qa",
  authMethod: "password" as const,
};
const jump = { ...host, id: "jump", name: "Jump" };
const review = { hostId: "host", revision: "a".repeat(64) };
const info = { hostId: "host", status: "known", fingerprint: "SHA256:reviewed" };
function fixture(
  handler: (request: ForwardingWindowMutation) => Promise<unknown> = async () => null,
) {
  const control = vi.fn(async (request: PanelWindowCommand): Promise<unknown> =>
    request.action === "beginInteraction" ? "original" : null,
  );
  const mutation = vi.fn(
    async (_lease: unknown, request: ForwardingWindowMutation): Promise<unknown> =>
      request.operation === "prepareStart"
        ? structuredClone({ host, jumpHosts: [jump], review })
        : handler(request),
  );
  const client = { control, forwardingMutation: mutation } as unknown as PanelWindowClient;
  const scope = createForwardingWindowPrompt(client, lease, target);
  return { client, control, mutation, scope };
}
it("captures original lease/target and releases a late acquisition without preparing any route", async () => {
  const admission = deferred<unknown>();
  const control = vi.fn((request: PanelWindowCommand) =>
    request.action === "beginInteraction" ? admission.promise : Promise.resolve(null),
  );
  const mutation = vi.fn();
  const requested = { ...lease },
    rule = { ...target };
  const scope = createForwardingWindowPrompt(
    { control, forwardingMutation: mutation } as unknown as PanelWindowClient,
    requested,
    rule,
  );
  const rejected = expect(scope.ready).rejects.toThrow("disposed");
  const closing = scope.close();
  requested.generation = 99;
  rule.id = "replacement";
  admission.resolve("late-original");
  await closing;
  await rejected;
  await scope.close();
  expect(control.mock.calls).toEqual([
    [{ action: "beginInteraction", lease }],
    [{ action: "endInteraction", lease, id: "late-original" }],
  ]);
  expect(mutation).not.toHaveBeenCalled();
});
it("preparation errors, foreign targets and provider routes release the original guard instead of downgrading", async () => {
  for (const plan of [
    new Error("route failed"),
    { host: { ...host, source: true }, jumpHosts: [], review },
    { host, jumpHosts: [{ ...jump, source: true }], review },
    { host: { ...host, id: "other" }, jumpHosts: [], review },
  ]) {
    const control = vi.fn(async (r: PanelWindowCommand): Promise<unknown> =>
      r.action === "beginInteraction" ? "original" : null,
    );
    const mutation = vi.fn(async () => {
      if (plan instanceof Error) throw plan;
      return plan;
    });
    const scope = createForwardingWindowPrompt(
      { control, forwardingMutation: mutation } as unknown as PanelWindowClient,
      lease,
      target,
    );
    await expect(scope.ready).rejects.toThrow(
      plan instanceof Error ? "route failed" : "unsupportedView",
    );
    expect(control).toHaveBeenLastCalledWith({ action: "endInteraction", lease, id: "original" });
    await scope.close();
    expect(mutation).toHaveBeenCalledTimes(1);
  }
});
it("serializes concurrent initial probe/credential effects, without poisoning the queue on a failed job", async () => {
  const probe = deferred<unknown>();
  const f = fixture(async (r) => {
    if (r.operation === "probe") return probe.promise;
    if (r.operation === "credentialStatus") throw new Error("keyring locked");
    return null;
  });
  const { services } = await f.scope.ready;
  const first = services.probe({});
  const bad = expect(services.credentialStatus("host")).rejects.toThrow("keyring locked");
  const last = services.credential("host", null);
  await vi.waitFor(() => expect(f.mutation).toHaveBeenCalledTimes(2));
  expect(f.mutation.mock.calls.map(([, r]) => r.operation)).toEqual(["prepareStart", "probe"]);
  probe.resolve(info);
  await first;
  await bad;
  await last;
  expect(f.mutation.mock.calls.map(([, r]) => r.operation)).toEqual([
    "prepareStart",
    "probe",
    "credentialStatus",
    "forgetCredential",
  ]);
  await f.scope.close();
});
it("advances trust review before any queued operation and projects immutable display-only route metadata", async () => {
  const f = fixture(async (r) =>
    r.operation === "trust" ? { info, review: { ...review, revision: "b".repeat(64) } } : info,
  );
  const { services, host: shown } = await f.scope.ready;
  expect(shown).toEqual(host);
  const route = await services.prepare();
  route.jumpHosts[0]!.id = "foreign";
  expect((await services.prepare()).jumpHosts[0]!.id).toBe("jump");
  const trusted = services.trust(info.fingerprint, {}, "host");
  const probe = services.probe({});
  await trusted;
  await probe;
  expect(f.mutation.mock.calls.at(-1)?.[1]).toMatchObject({
    operation: "probe",
    review: { revision: "b".repeat(64) },
  });
  await expect(services.credentialStatus("foreign")).rejects.toThrow("connectionChanged");
  await f.scope.close();
});
it("uses complete typed private services, snapshots secret inputs before queue waits, and strips arbitrary SSH parameters", async () => {
  const hold = deferred<unknown>();
  const f = fixture(async (r) =>
    r.operation === "probe"
      ? hold.promise
      : r.operation === "credentialStatus"
        ? true
        : { id: "session", hostId: "host" },
  );
  const { services } = await f.scope.ready;
  const probe = services.probe({});
  const request = {
    hostId: "host",
    password: "typed",
    passphrase: null,
    jumpCredentials: { jump: { password: "hop" } },
    background: false,
    cols: 999,
    rows: 999,
    purpose: "forwarding" as const,
  };
  const start = services.connect(request);
  request.password = "changed";
  request.jumpCredentials.jump.password = "changed";
  const status = services.credentialStatus("jump");
  const save = services.credential("host", "saved");
  const forget = services.credential("jump", null);
  const credentials = { jump: { passphrase: "request-only" } };
  const install = services.installKey("installation", credentials);
  credentials.jump.passphrase = "changed";
  hold.resolve(info);
  await Promise.all([probe, start, status, save, forget, install]);
  const sent = f.mutation.mock.calls.map(([, r]) => r);
  const base = { id: "rule", revision: "displayed", interaction: "original", review };
  expect(sent.find((r) => r.operation === "start")).toEqual({
    ...base,
    operation: "start",
    credentials: { password: "typed", passphrase: null, jumps: { jump: { password: "hop" } } },
  });
  expect(sent.find((r) => r.operation === "credentialStatus")).toEqual({
    ...base,
    operation: "credentialStatus",
    hostId: "jump",
  });
  expect(sent.find((r) => r.operation === "saveCredential")).toEqual({
    ...base,
    operation: "saveCredential",
    hostId: "host",
    password: "saved",
  });
  expect(sent.find((r) => r.operation === "forgetCredential")).toEqual({
    ...base,
    operation: "forgetCredential",
    hostId: "jump",
  });
  expect(sent.find((r) => r.operation === "installKey")).toEqual({
    ...base,
    operation: "installKey",
    password: "installation",
    credentials: { jump: { passphrase: "request-only" } },
  });
  await expect(services.connect({ hostId: "foreign", cols: 80, rows: 24 })).rejects.toThrow(
    "connectionChanged",
  );
  await f.scope.close();
});
it("cancel bypasses a running test without unlocking the queue before native settlement", async () => {
  const pending = deferred<unknown>();
  const f = fixture(async (r) =>
    r.operation === "test" ? pending.promise : r.operation === "credentialStatus" ? true : null,
  );
  const { services } = await f.scope.ready;
  const id = crypto.randomUUID();
  const tested = expect(services.test(id, {})).rejects.toThrow("testCancelled");
  await vi.waitFor(() => expect(f.mutation.mock.calls.at(-1)?.[1].operation).toBe("test"));
  const status = services.credentialStatus("host");
  await services.cancelTest(id);
  expect(f.mutation.mock.calls.at(-1)?.[1]).toEqual({
    operation: "cancelTest",
    testId: id,
    interaction: "original",
  });
  expect(f.mutation.mock.calls.some(([, r]) => r.operation === "credentialStatus")).toBe(false);
  pending.reject(new Error("ssh.testCancelled"));
  await tested;
  await status;
  expect(f.mutation.mock.calls.at(-1)?.[1].operation).toBe("credentialStatus");
  await f.scope.close();
});
it("cancel before queued test admission is sticky and cannot retarget or replay it", async () => {
  const probe = deferred<unknown>();
  const f = fixture(async (r) => (r.operation === "probe" ? probe.promise : null));
  const { services } = await f.scope.ready;
  const active = services.probe({});
  const id = crypto.randomUUID();
  const canceled = expect(services.test(id, { jump: { password: "secret" } })).rejects.toThrow(
    "testCancelled",
  );
  await services.cancelTest(id);
  probe.resolve(info);
  await active;
  await canceled;
  expect(f.mutation.mock.calls.some(([, r]) => r.operation === "test")).toBe(false);
  await expect(services.test(id, {})).rejects.toThrow("testCancelled");
  await f.scope.close();
});
it("close retires original consent immediately and rejects queued effects/late results without reconnecting", async () => {
  const pending = deferred<unknown>();
  const f = fixture(async () => pending.promise);
  const { services } = await f.scope.ready;
  const first = expect(services.connect({ hostId: "host", cols: 80, rows: 24 })).rejects.toThrow(
    "disposed",
  );
  await vi.waitFor(() => expect(f.mutation.mock.calls.at(-1)?.[1].operation).toBe("start"));
  const queued = expect(services.credential("host", "must-not-save")).rejects.toThrow("disposed");
  await f.scope.close();
  expect(f.control).toHaveBeenLastCalledWith({ action: "endInteraction", lease, id: "original" });
  pending.resolve({ id: "already-admitted" });
  await first;
  await queued;
  expect(f.mutation.mock.calls.map(([, r]) => r.operation)).toEqual(["prepareStart", "start"]);
  await expect(services.probe({})).rejects.toThrow("disposed");
});
it("bounds live-dialog history without evicting early cancellations and retries only original cleanup", async () => {
  const f = fixture();
  const { services } = await f.scope.ready;
  const ids = Array.from({ length: 64 }, () => crypto.randomUUID());
  for (const id of ids) await services.cancelTest(id);
  await expect(services.cancelTest(crypto.randomUUID())).rejects.toThrow("sessionBusy");
  await expect(services.test(ids[0]!, {})).rejects.toThrow("testCancelled");
  f.control.mockRejectedValueOnce(new Error("temporary cleanup failure"));
  await expect(f.scope.close()).rejects.toThrow("temporary cleanup failure");
  await f.scope.close();
  expect(f.control.mock.calls.filter(([r]) => r.action === "beginInteraction")).toHaveLength(1);
  expect(f.control.mock.calls.filter(([r]) => r.action === "endInteraction")).toEqual([
    [{ action: "endInteraction", lease, id: "original" }],
    [{ action: "endInteraction", lease, id: "original" }],
  ]);
});

it("keeps every provider prompt operation on its original native child, never builtin or raw provider IPC", async () => {
  const { createForwardingProviderWindowPrompt } =
    await import("@/features/forwarding/runtime/windowPrompt");
  const control = vi.fn(async (r: PanelWindowCommand): Promise<unknown> =>
    r.action === "beginInteraction" ? "provider-original" : null,
  );
  const builtin = vi.fn(async () => {
    throw new Error("builtin fallback forbidden");
  });
  let revoked = false;
  const provider = {
    forwardingMutation: vi.fn(
      async (_token: string, _lease: unknown, r: ForwardingWindowMutation): Promise<unknown> => {
        if (revoked) throw new Error("plugin.frontend.expired");
        if (r.operation === "prepareStart")
          return structuredClone({ host, jumpHosts: [jump], review });
        if (r.operation === "trust")
          return { info, review: { ...review, revision: "b".repeat(64) } };
        if (r.operation === "start") return { id: "provider-session", hostId: host.id };
        return null;
      },
    ),
  };
  const requested = { ...lease },
    displayed = { ...target };
  const scope = createForwardingProviderWindowPrompt(
    { control, forwardingMutation: builtin } as unknown as PanelWindowClient,
    provider as unknown as Parameters<typeof createForwardingProviderWindowPrompt>[1],
    requested,
    displayed,
    "original-native-child",
  );
  requested.generation = 999;
  displayed.id = "replacement";
  const { services } = await scope.ready;
  await services.credentialStatus(host.id);
  await services.probe({});
  await services.trust(info.fingerprint, {}, host.id);
  await services.test(crypto.randomUUID(), {});
  await services.cancelTest(crypto.randomUUID());
  await services.credential(host.id, "ephemeral");
  await services.credential(host.id, null);
  await services.installKey("ephemeral", {});
  await services.connect({ hostId: host.id, cols: 80, rows: 24, password: "ephemeral" });
  for (const [token, actualLease, request] of provider.forwardingMutation.mock.calls) {
    expect(token).toBe("original-native-child");
    expect(actualLease).toEqual(lease);
    expect(request).toHaveProperty("interaction", "provider-original");
    if ("id" in request) expect(request.id).toBe(target.id);
    if ("revision" in request) expect(request.revision).toBe(target.revision);
  }
  expect(provider.forwardingMutation.mock.calls.at(-1)?.[2]).toMatchObject({
    review: { revision: "b".repeat(64) },
  });
  revoked = true;
  await expect(services.connect({ hostId: host.id, cols: 80, rows: 24 })).rejects.toThrow(
    "expired",
  );
  expect(builtin).not.toHaveBeenCalled();
  await scope.close();
  expect(control).toHaveBeenLastCalledWith({
    action: "endInteraction",
    lease,
    id: "provider-original",
  });
});

it("releases original consent after native provider preparation rejects without retrying as builtin", async () => {
  const { createForwardingProviderWindowPrompt } =
    await import("@/features/forwarding/runtime/windowPrompt");
  const admission = deferred<unknown>();
  const control = vi.fn((r: PanelWindowCommand) =>
    r.action === "beginInteraction" ? admission.promise : Promise.resolve(null),
  );
  const builtin = vi.fn(),
    provider = {
      forwardingMutation: vi.fn().mockRejectedValue(new Error("plugin.forwarding.expired")),
    };
  const scope = createForwardingProviderWindowPrompt(
    { control, forwardingMutation: builtin } as unknown as PanelWindowClient,
    provider,
    lease,
    target,
    "original",
  );
  const rejected = expect(scope.ready).rejects.toThrow("expired");
  admission.resolve("original-consent");
  await rejected;
  expect(provider.forwardingMutation).toHaveBeenCalledTimes(1);
  expect(builtin).not.toHaveBeenCalled();
  expect(control).toHaveBeenLastCalledWith({
    action: "endInteraction",
    lease,
    id: "original-consent",
  });
});

it("rejects an absent native provider token without invoking any mutation route and releases consent", async () => {
  const { createForwardingProviderWindowPrompt } =
    await import("@/features/forwarding/runtime/windowPrompt");
  const control = vi.fn(async (r: PanelWindowCommand): Promise<unknown> =>
    r.action === "beginInteraction" ? "original" : null,
  );
  const builtin = vi.fn();
  const provider = { forwardingMutation: vi.fn() };
  const scope = createForwardingProviderWindowPrompt(
    { control, forwardingMutation: builtin } as unknown as PanelWindowClient,
    provider,
    lease,
    target,
    "",
  );
  await expect(scope.ready).rejects.toThrow("expired");
  expect(provider.forwardingMutation).not.toHaveBeenCalled();
  expect(builtin).not.toHaveBeenCalled();
  expect(control).toHaveBeenLastCalledWith({ action: "endInteraction", lease, id: "original" });
});
