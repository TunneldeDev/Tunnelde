import { expect, it, vi } from "vitest";
import { createNativePluginViewClient } from "@/lib/panels/windowPluginClient";
import type { FrontendSession } from "@/lib/extensions/frontendRuntime";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  convertFileSrc: (token: string, protocol: string) => `${protocol}://${token}`,
}));
const session: FrontendSession = {
  token: "child-token",
  pluginId: "sample",
  generation: 8,
  runtimeId: "runtime:8",
  entry: "nested/view file.mjs",
  sdkVersion: "0.1.0",
};
const identity = { windowId: "satellite", document: "exact-native-document" };
const target = { kind: "staged" as const, id: "incoming-offer" };
function fixture() {
  const invoke = vi.fn(
    async (_command: string, args: { request: { action: string } }): Promise<unknown> => {
      if (args.request.action === "open") return { ...session };
      if (args.request.action === "prepareCall") return "ticket";
      if (args.request.action === "call") return { ok: true };
      return null;
    },
  );
  const load = vi.fn(async () => ({ activate: vi.fn() }));
  const report = vi.fn();
  const client = createNativePluginViewClient(identity, { invoke: invoke as never, load, report });
  const open = () => client.open(target, "sample", "runtime:8", "files");
  return { client, open, invoke, load, report };
}
it("uses only the dedicated native document gateway, with no raw IPC or singleton activation secret", async () => {
  const f = fixture();
  const view = await f.open();
  expect(view).toEqual(session);
  expect(f.invoke).toHaveBeenCalledWith("panel_window_plugin_view", {
    document: identity.document,
    request: {
      action: "open",
      target,
      pluginId: "sample",
      runtimeId: "runtime:8",
      viewId: "files",
    },
  });
  expect(await f.client.transport.call(view.token, "bus.snapshot", {})).toEqual({ ok: true });
  expect(f.invoke.mock.calls.map(([, args]) => args.request.action)).toEqual([
    "open",
    "prepareCall",
    "call",
    "cancelCall",
  ]);
  for (const [command, args] of f.invoke.mock.calls) {
    expect(command).toBe("panel_window_plugin_view");
    expect(args).not.toHaveProperty("windowId");
    expect(args).not.toHaveProperty("activation");
  }
  f.client.dispose();
});
it("loads the immutable child module without encoding path separators or activating another runtime", async () => {
  const f = fixture();
  await f.open();
  const module = await f.client.transport.load(session);
  expect(f.load).toHaveBeenCalledWith("tunnelde-ui://child-token/nested/view%20file.mjs");
  expect(module.activate).not.toHaveBeenCalled();
  f.client.dispose();
});
it("never allocates a request for an already aborted signal or an unknown/closed child", async () => {
  const f = fixture();
  const controller = new AbortController();
  await f.open();
  controller.abort();
  await expect(
    f.client.transport.call(session.token, "bus.receive", {}, controller.signal),
  ).rejects.toThrow("cancelled");
  await expect(f.client.transport.call("foreign", "bus.snapshot", {})).rejects.toThrow();
  await f.client.transport.close(session.token);
  await expect(f.client.transport.call(session.token, "bus.snapshot", {})).rejects.toThrow();
  await expect(f.client.transport.load(session)).rejects.toThrow();
  expect(f.invoke.mock.calls.map(([, args]) => args.request.action)).toEqual(["open", "close"]);
  f.client.dispose();
});
it("cancels a late reservation without dispatch when caller abort wins", async () => {
  const f = fixture();
  await f.open();
  let reserve!: (value: string) => void;
  f.invoke.mockImplementationOnce(
    () =>
      new Promise((done) => {
        reserve = done as never;
      }),
  );
  const controller = new AbortController();
  const pending = f.client.transport.call(session.token, "bus.receive", {}, controller.signal);
  controller.abort();
  reserve("late-ticket");
  await expect(pending).rejects.toThrow("cancelled");
  expect(f.invoke.mock.calls.map(([, args]) => args.request.action)).toEqual([
    "open",
    "prepareCall",
    "cancelCall",
  ]);
  expect(f.invoke).toHaveBeenLastCalledWith("panel_window_plugin_view", {
    document: identity.document,
    request: { action: "cancelCall", token: session.token, requestId: "late-ticket" },
  });
  f.client.dispose();
});
it("disposal cancels active calls, closes attachments exactly once and discards late results", async () => {
  const f = fixture();
  await f.open();
  let reply!: (value: unknown) => void;
  f.invoke.mockImplementation(async (_command, args) => {
    if (args.request.action === "prepareCall") return "live-ticket";
    if (args.request.action === "call")
      return new Promise((done) => {
        reply = done;
      });
    return null;
  });
  const pending = f.client.transport.call(session.token, "bus.receive", {});
  await vi.waitFor(() => expect(reply).toBeTypeOf("function"));
  f.client.dispose();
  f.client.dispose();
  reply({ shouldNotDeliver: true });
  await expect(pending).rejects.toThrow();
  expect(f.invoke.mock.calls.filter(([, args]) => args.request.action === "close")).toHaveLength(1);
  expect(
    f.invoke.mock.calls.filter(([, args]) => args.request.action === "cancelCall"),
  ).toHaveLength(1);
  await expect(f.open()).rejects.toThrow();
});
it("closes an attachment whose open reply arrives after document disposal", async () => {
  const f = fixture();
  let reply!: (value: FrontendSession) => void;
  f.invoke.mockImplementationOnce(
    () =>
      new Promise((done) => {
        reply = done as never;
      }),
  );
  const pending = f.open();
  f.client.dispose();
  reply(session);
  await expect(pending).rejects.toThrow();
  expect(f.invoke.mock.calls.map(([, args]) => args.request.action)).toEqual(["open", "close"]);
});
it("fences a module import completing after close and never cancels other attachments", async () => {
  const f = fixture();
  await f.open();
  let reply!: (value: object) => void;
  f.load.mockImplementationOnce(
    () =>
      new Promise((done) => {
        reply = done as never;
      }),
  );
  const pending = f.client.transport.load(session);
  await f.client.transport.close(session.token);
  reply({ createView: () => {} });
  await expect(pending).rejects.toThrow();
  await f.client.transport.close("unknown");
  expect(f.invoke.mock.calls.filter(([, args]) => args.request.action === "close")).toHaveLength(1);
  f.client.dispose();
});
it("contains cleanup reporting failures and snapshots document identity rather than following mutable input", async () => {
  const mutable = { ...identity };
  const report = vi.fn(() => {
    throw new Error("report failed");
  });
  const invoke = vi.fn(async (_command, args) => {
    if (args.request.action === "open") return session;
    if (args.request.action === "close") throw new Error("old document retired");
  });
  const client = createNativePluginViewClient(mutable, { invoke: invoke as never, report });
  mutable.document = "forged replacement";
  await client.open(target, "sample", "runtime:8", "files");
  client.dispose();
  await vi.waitFor(() => expect(report).toHaveBeenCalledOnce());
  for (const [, args] of invoke.mock.calls) expect(args.document).toBe(identity.document);
});

it("admits adapters only from the coordinator using IDs, not JS-supplied permissions or activation metadata", async () => {
  const native = vi.fn(async () => ({ panelId: "plugin:sample:files" }));
  const satellite = createNativePluginViewClient(identity, {
    invoke: native as never,
    report: vi.fn(),
  });
  await expect(satellite.registerAdapter("sample", "runtime:8", "files")).rejects.toThrow(
    "coordinatorRequired",
  );
  expect(native).not.toHaveBeenCalled();
  const main = createNativePluginViewClient(
    { windowId: "main", document: "exact-main" },
    {
      invoke: native as never,
      report: vi.fn(),
    },
  );
  expect(await main.registerAdapter("sample", "runtime:8", "files")).toEqual({
    panelId: "plugin:sample:files",
  });
  expect(native).toHaveBeenCalledExactlyOnceWith("panel_window_plugin_view", {
    document: "exact-main",
    request: {
      action: "registerAdapter",
      pluginId: "sample",
      runtimeId: "runtime:8",
      viewId: "files",
    },
  });
  main.dispose();
  satellite.dispose();
});
it("discards adapter approval replies after their initiating document client is disposed", async () => {
  let finish!: (value: unknown) => void;
  const native = vi.fn(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const main = createNativePluginViewClient(
    { windowId: "main", document: "exact-main" },
    {
      invoke: native as never,
      report: vi.fn(),
    },
  );
  const pending = main.registerAdapter("sample", "runtime:8", "files");
  main.dispose();
  finish({ panelId: "plugin:sample:files" });
  await expect(pending).rejects.toThrow("closed");
});
it("withdraws only the exact public owner tuple without spreading descriptor metadata into closed IPC", async () => {
  const native = vi.fn(async () => true);
  const main = createNativePluginViewClient(
    { windowId: "main", document: "exact-main" },
    {
      invoke: native as never,
      report: vi.fn(),
    },
  );
  const descriptor = {
    panelId: "plugin:sample:files",
    runtimeId: "runtime",
    generation: 8,
    revision: "exact-approval",
    title: "ignored",
    pluginId: "ignored",
  };
  expect(await main.unregisterAdapter(descriptor)).toBe(true);
  expect(native).toHaveBeenCalledExactlyOnceWith("panel_window_plugin_view", {
    document: "exact-main",
    request: {
      action: "unregisterAdapter",
      panelId: descriptor.panelId,
      runtimeId: "runtime",
      generation: 8,
      revision: "exact-approval",
    },
  });
  const satellite = createNativePluginViewClient(identity, {
    invoke: native as never,
    report: vi.fn(),
  });
  await expect(satellite.unregisterAdapter(descriptor)).rejects.toThrow("coordinatorRequired");
  expect(native).toHaveBeenCalledTimes(1);
  satellite.dispose();
  main.dispose();
});

it("opens selected forwarding attachments through exact native identity, never a singleton or caller-supplied permissions", async () => {
  const f = fixture();
  const descriptor = {
    selectionRevision: 4,
    view: {
      pluginId: "sample",
      runtimeId: "runtime:8",
      viewId: "forwards",
      generation: 8,
      entry: "index.mjs",
      sdkVersion: "0.1.0",
      title: "Forwarding",
      allowFloating: true,
    },
  };
  f.invoke.mockResolvedValueOnce(descriptor).mockResolvedValueOnce(session);
  const owned = {
    kind: "owned" as const,
    lease: { panelId: "forwarding", windowId: "satellite", generation: 2 },
  };
  expect(await f.client.describeForwardingProvider(owned)).toBe(descriptor);
  const pending = f.client.openForwardingProvider(owned, "host", descriptor);
  owned.lease.generation = 3;
  descriptor.selectionRevision = 9;
  expect(await pending).toEqual(session);
  expect(f.invoke).toHaveBeenLastCalledWith("panel_window_plugin_view", {
    document: identity.document,
    request: {
      action: "openForwardingProvider",
      target: {
        kind: "owned",
        lease: { panelId: "forwarding", windowId: "satellite", generation: 2 },
      },
      hostId: "host",
      pluginId: "sample",
      runtimeId: "runtime:8",
      viewId: "forwards",
      selectionRevision: 4,
    },
  });
  expect(await f.client.transport.call(session.token, "api.describe", {})).toEqual({ ok: true });
  f.client.dispose();
});
it("closes a late forwarding-provider acquisition rather than adopting it after disposal", async () => {
  const f = fixture();
  let finish!: (value: unknown) => void;
  f.invoke.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const descriptor = {
    selectionRevision: 4,
    view: { ...session, viewId: "forwards", title: "Provider", allowFloating: true },
  };
  const pending = f.client.openForwardingProvider(target, "host", descriptor);
  f.client.dispose();
  finish(session);
  await expect(pending).rejects.toThrow();
  expect(f.invoke.mock.calls.map(([, args]) => args.request.action)).toEqual([
    "openForwardingProvider",
    "close",
  ]);
  await expect(f.client.describeForwardingProvider(target)).rejects.toThrow();
});

it("snapshots provider mutations with only the original native child and lease, never falling back to builtin IPC", async () => {
  const f = fixture();
  await f.open();
  const lease = { panelId: "forwarding", windowId: "satellite", generation: 2 };
  const mutation = { operation: "saveGroup" as const, hostId: "host", name: "Original group" };
  const pending = f.client.forwardingMutation(session.token, lease, mutation);
  lease.generation = 3;
  mutation.name = "Later edit";
  expect(await pending).toBeNull();
  expect(f.invoke).toHaveBeenLastCalledWith("panel_window_plugin_view", {
    document: identity.document,
    request: {
      action: "forwarding",
      token: session.token,
      lease: { panelId: "forwarding", windowId: "satellite", generation: 2 },
      request: { operation: "saveGroup", hostId: "host", name: "Original group" },
    },
  });
  f.invoke.mockRejectedValueOnce(new Error("plugin.forwarding.expired"));
  await expect(f.client.forwardingMutation(session.token, lease, mutation)).rejects.toThrow(
    "plugin.forwarding.expired",
  );
  expect(f.invoke.mock.calls.every(([command]) => command === "panel_window_plugin_view")).toBe(
    true,
  );
  await f.client.transport.close(session.token);
  const count = f.invoke.mock.calls.length;
  await expect(f.client.forwardingMutation(session.token, lease, mutation)).rejects.toThrow();
  expect(f.invoke.mock.calls).toHaveLength(count);
  f.client.dispose();
});
