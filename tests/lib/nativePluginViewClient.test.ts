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
