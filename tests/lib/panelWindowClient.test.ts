import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createPanelWindowClient, initializePanelWindow } from "@/lib/panels/windowClient";
const native = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: native.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: native.listen }));
beforeEach(() => {
  native.invoke.mockReset();
  native.listen.mockReset();
});
afterEach(() => vi.restoreAllMocks());
const identity = { windowId: "panel-one", document: "native-document" };
it("initializes through native identity and never passes a client-supplied window label as authority", async () => {
  native.invoke.mockResolvedValueOnce(identity).mockResolvedValueOnce({ panels: [] });
  const client = await initializePanelWindow();
  await client.snapshot();
  expect(native.invoke.mock.calls).toEqual([
    ["panel_window_initialize"],
    ["panel_window_control", { document: "native-document", request: { action: "snapshot" } }],
  ]);
  expect(client.windowId).toBe("panel-one");
  client.dispose();
});
it("fences in-flight replies and rejects mutations after disposal", async () => {
  let resolve!: (value: unknown) => void;
  native.invoke.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const client = createPanelWindowClient(identity);
  const pending = client.snapshot();
  client.dispose();
  resolve({ panels: [] });
  await expect(pending).rejects.toThrow("disposed");
  await expect(client.control({ action: "ready" })).rejects.toThrow("disposed");
  expect(native.invoke).toHaveBeenCalledTimes(1);
});
it("releases late subscriptions, is idempotent, and never delivers callbacks after disposal", async () => {
  let receive!: () => void, done!: (stop: () => void) => void;
  const stop = vi.fn(),
    changed = vi.fn();
  native.listen.mockImplementation((_name, callback: () => void) => {
    receive = callback;
    return new Promise((resolve) => {
      done = resolve;
    });
  });
  const client = createPanelWindowClient(identity);
  const pending = client.subscribe(changed);
  client.dispose();
  done(stop);
  await pending;
  receive();
  expect(changed).not.toHaveBeenCalled();
  expect(stop).toHaveBeenCalledTimes(1);
  client.dispose();
  expect(stop).toHaveBeenCalledTimes(1);
});
it("subscribes to advisory events without reading or emitting secrets", async () => {
  const stop = vi.fn(),
    close = vi.fn();
  let receive!: () => void;
  native.listen.mockImplementation((_name, callback: () => void) => {
    receive = callback;
    return Promise.resolve(stop);
  });
  const client = createPanelWindowClient(identity);
  await client.onClose(close);
  receive();
  expect(close).toHaveBeenCalledTimes(1);
  client.dispose();
  receive();
  expect(close).toHaveBeenCalledTimes(1);
  expect(stop).toHaveBeenCalledTimes(1);
  expect(native.invoke).not.toHaveBeenCalled();
});

it("makes explicit unsubscribe and document disposal share one idempotent release", async () => {
  const stop = vi.fn();
  native.listen.mockResolvedValue(stop);
  const client = createPanelWindowClient(identity);
  const release = await client.subscribe(vi.fn());
  release();
  release();
  client.dispose();
  release();
  expect(stop).toHaveBeenCalledTimes(1);
});
it("binds the closed resource/focus gateways to native document identity and the exact lease", async () => {
  const client = createPanelWindowClient(identity);
  const lease = { panelId: "connections", windowId: identity.windowId, generation: 5 };
  native.invoke.mockResolvedValue(null);
  await client.disconnect(lease, "session-1");
  expect(native.invoke).toHaveBeenLastCalledWith("panel_window_disconnect", {
    document: identity.document,
    lease,
    sessionId: "session-1",
  });
  await client.focus("connections");
  expect(native.invoke).toHaveBeenLastCalledWith("panel_window_focus", {
    document: identity.document,
    panelId: "connections",
  });
  client.dispose();
  await expect(client.focus("connections")).rejects.toThrow("disposed");
  await expect(client.disconnect(lease, "session-1")).rejects.toThrow("disposed");
});

it("retains a late native claim reply so disposed executors can release admitted fences", async () => {
  let reply!: (jobs: unknown[]) => void;
  native.invoke.mockImplementationOnce(
    () =>
      new Promise((done) => {
        reply = done;
      }),
  );
  const client = createPanelWindowClient({ windowId: "main", document: "main-document" });
  const pending = client.claimActions();
  client.dispose();
  const jobs = [{ id: "claimed" }];
  reply(jobs);
  expect(await pending).toEqual(jobs);
  native.invoke.mockResolvedValueOnce(null);
  await client.finalizeAction("claimed", { status: "failed", message: "disposed" });
  expect(native.invoke).toHaveBeenLastCalledWith("panel_window_control", {
    document: "main-document",
    request: {
      action: "completeAction",
      id: "claimed",
      result: { status: "failed", message: "disposed" },
    },
  });
  await expect(client.claimActions()).rejects.toThrow("disposed");
});

it("polls an action using only its native-issued id and propagates remote failures", async () => {
  const lease = { panelId: "tasks", windowId: identity.windowId, generation: 5 };
  native.invoke
    .mockResolvedValueOnce("request-id")
    .mockResolvedValueOnce({ status: "failed", message: "changed" });
  const client = createPanelWindowClient(identity);
  await expect(client.action(lease, { kind: "clearTasks" })).rejects.toThrow("changed");
  expect(native.invoke.mock.calls).toEqual([
    [
      "panel_window_control",
      {
        document: identity.document,
        request: { action: "requestAction", lease, request: { kind: "clearTasks" } },
      },
    ],
    [
      "panel_window_control",
      { document: identity.document, request: { action: "actionResult", id: "request-id" } },
    ],
  ]);
});

it("cancels a submission when disposal wins its reply and never starts a new request after abort", async () => {
  const lease = { panelId: "tasks", windowId: identity.windowId, generation: 5 };
  let reply!: (id: string) => void;
  native.invoke
    .mockImplementationOnce(
      () =>
        new Promise((done) => {
          reply = done;
        }),
    )
    .mockResolvedValue(null);
  const client = createPanelWindowClient(identity);
  const pending = client.action(lease, { kind: "clearTasks" });
  client.dispose();
  reply("unclaimed");
  await expect(pending).rejects.toThrow("disposed");
  expect(native.invoke).toHaveBeenLastCalledWith("panel_window_control", {
    document: identity.document,
    request: { action: "cancelAction", id: "unclaimed" },
  });
  const other = createPanelWindowClient(identity);
  const abort = new AbortController();
  abort.abort();
  const count = native.invoke.mock.calls.length;
  await expect(other.action(lease, { kind: "clearTasks" }, abort.signal)).rejects.toThrow(
    "Cancelled",
  );
  expect(native.invoke).toHaveBeenCalledTimes(count);
});

it("includes the exact owning lease when requesting a native destination from a satellite", async () => {
  const client = createPanelWindowClient(identity);
  const lease = { panelId: "tasks", windowId: identity.windowId, generation: 5 };
  native.invoke.mockResolvedValueOnce("new-destination");
  expect(await client.create(lease)).toBe("new-destination");
  expect(native.invoke).toHaveBeenLastCalledWith("panel_window_create", {
    document: identity.document,
    lease,
  });
});

it("retains late move claims for cleanup, but never starts more work after local disposal", async () => {
  let resolve!: (value: unknown) => void;
  native.invoke.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const client = createPanelWindowClient({ windowId: "satellite", document: "doc" });
  const late = client.claimPanelMoves();
  client.dispose();
  const jobs = [
    {
      id: "native-job",
      lease: { panelId: "tasks", windowId: "satellite", generation: 4 },
      targetWindow: "main",
    },
  ];
  resolve(jobs);
  expect(await late).toEqual(jobs);
  await client.failPanelMove("native-job");
  expect(native.invoke).toHaveBeenLastCalledWith("panel_window_control", {
    document: "doc",
    request: { action: "failPanelMove", id: "native-job" },
  });
  await expect(client.claimPanelMoves()).rejects.toThrow("disposed");
});

it("delivers target-window focus metadata only and disposes late focus listeners", async () => {
  let receive!: (event: { payload: unknown }) => void;
  const unlisten = vi.fn(),
    focused = vi.fn();
  native.listen.mockImplementation((_name, callback) => {
    receive = callback;
    return Promise.resolve(unlisten);
  });
  const client = createPanelWindowClient(identity);
  const release = await client.onPanelFocus(focused);
  const lease = { panelId: "tasks", windowId: identity.windowId, generation: 7 };
  receive({ payload: { ...lease, windowId: "other" } });
  expect(focused).not.toHaveBeenCalled();
  receive({ payload: lease });
  expect(focused).toHaveBeenCalledExactlyOnceWith(lease);
  release();
  client.dispose();
  receive({ payload: lease });
  expect(focused).toHaveBeenCalledOnce();
  expect(unlisten).toHaveBeenCalledOnce();
  const late = createPanelWindowClient(identity);
  let settle!: (stop: () => void) => void;
  native.listen.mockImplementationOnce((_name, callback) => {
    receive = callback;
    return new Promise((resolve) => {
      settle = resolve;
    });
  });
  const pending = late.onPanelFocus(focused);
  late.dispose();
  settle(unlisten);
  await pending;
  receive({ payload: lease });
  expect(focused).toHaveBeenCalledOnce();
  expect(unlisten).toHaveBeenCalledTimes(2);
  expect(native.invoke).not.toHaveBeenCalled();
});

it("preserves late source presentation claims and permits cleanup-only completion after disposal", async () => {
  let settle!: (value: unknown) => void;
  native.invoke
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        }),
    )
    .mockResolvedValue(null);
  const client = createPanelWindowClient(identity);
  const pending = client.claimPresentations();
  client.dispose();
  const jobs = [
    {
      id: "p",
      lease: { panelId: "tasks", windowId: identity.windowId, generation: 2 },
      operation: { kind: "close" },
    },
  ];
  settle(jobs);
  expect(await pending).toEqual(jobs);
  await expect(client.claimPresentations()).rejects.toThrow("disposed");
  const metadata = {
    presentation: "workspace" as const,
    visible: false,
    pinned: true,
    bounds: null,
    available: true,
    presentations: ["workspace" as const],
  };
  await client.completePresentation("p", metadata);
  await client.failPresentation("p");
  expect(native.invoke.mock.calls.slice(-2)).toEqual([
    [
      "panel_window_control",
      {
        document: identity.document,
        request: { action: "completePresentation", id: "p", metadata },
      },
    ],
    [
      "panel_window_control",
      { document: identity.document, request: { action: "failPresentation", id: "p" } },
    ],
  ]);
});
