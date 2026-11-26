import { expect, it, vi } from "vitest";
vi.mock("@/lib/panels/presentationRequests", () => ({
  publishStagedPresentation: vi.fn().mockResolvedValue(undefined),
}));
import { startPanelWindowCoordinator } from "@/lib/panels/windowCoordinator";
import { createWindowViews, useWindowViews } from "@/lib/panels/windowViews";
import type { PanelWindowClient } from "@/lib/panels/windowClient";
import type { NativePanelSnapshot, PanelWindowCommand } from "@/lib/panels/windowProtocol";
const settle = async () => {
  for (let n = 0; n < 30; n++) await Promise.resolve();
};
function fixture() {
  let changed = () => {};
  let snapshot: NativePanelSnapshot = {
    windows: [{ id: "main", ready: true, closing: false }],
    panels: [],
    transfers: [],
  };
  const stop = vi.fn(),
    failure = vi.fn(),
    receive = vi.fn();
  const control = vi.fn(async (command: PanelWindowCommand): Promise<unknown> => {
    if (command.action === "addPanel")
      snapshot = {
        ...snapshot,
        panels: [...snapshot.panels, { panelId: command.panelId, windowId: "main", generation: 1 }],
      };
    if (command.action === "removePanel")
      snapshot = {
        ...snapshot,
        panels: snapshot.panels.filter((p) => p.panelId !== command.panelId),
      };
    return null;
  });
  const client = {
    windowId: "main",
    snapshot: vi.fn(async () => snapshot),
    subscribe: vi.fn(async (fn: () => void) => {
      changed = fn;
      return stop;
    }),
    control,
  } as unknown as PanelWindowClient;
  return {
    client,
    control,
    stop,
    failure,
    receive,
    changed: () => changed(),
    setSnapshot: (next: NativePanelSnapshot) => {
      snapshot = next;
    },
    snapshot: () => snapshot,
  };
}
it("registers available panels without stealing an existing satellite owner and removes retired contributions", async () => {
  const f = fixture();
  f.setSnapshot({
    ...f.snapshot(),
    panels: [
      { panelId: "connections", windowId: "panel-one", generation: 7 },
      { panelId: "plugin:removed:view", windowId: "panel-one", generation: 8 },
    ],
  });
  const c = startPanelWindowCoordinator(f.client, {
    panelIds: () => ["connections", "tasks"],
    receive: f.receive,
    failure: f.failure,
  });
  await c.ready;
  await settle();
  expect(f.control.mock.calls.map(([r]) => r)).toEqual([
    { action: "ready" },
    { action: "removePanel", panelId: "plugin:removed:view" },
    { action: "addPanel", panelId: "tasks" },
  ]);
  expect(f.receive.mock.lastCall?.[0].panels).toEqual([
    { panelId: "connections", windowId: "panel-one", generation: 7 },
    { panelId: "tasks", windowId: "main", generation: 1 },
  ]);
  expect(f.failure).not.toHaveBeenCalled();
  c.dispose();
});
it("does not acknowledge a destination which has no prepared view adapter", async () => {
  const f = fixture();
  f.setSnapshot({
    ...f.snapshot(),
    panels: [{ panelId: "connections", windowId: "other", generation: 1 }],
    transfers: [
      {
        offer: {
          id: "offer",
          lease: { panelId: "connections", windowId: "other", generation: 1 },
          targetWindow: "main",
        },
        ready: false,
      },
    ],
  });
  const c = startPanelWindowCoordinator(f.client, {
    panelIds: () => ["connections"],
    receive: f.receive,
    failure: f.failure,
  });
  await c.ready;
  await settle();
  expect(f.control).toHaveBeenCalledExactlyOnceWith({ action: "ready" });
  c.dispose();
});
it("acknowledges only after staging and commits ready transfers through the singleton", async () => {
  const f = fixture();
  let complete!: () => void;
  const stage = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        complete = resolve;
      }),
  );
  const offer = {
    id: "offer",
    lease: { panelId: "connections", windowId: "other", generation: 1 },
    targetWindow: "main",
  };
  f.setSnapshot({ ...f.snapshot(), panels: [offer.lease], transfers: [{ offer, ready: false }] });
  const c = startPanelWindowCoordinator(f.client, {
    panelIds: () => ["connections"],
    receive: f.receive,
    failure: f.failure,
    stage,
  });
  f.control.mockImplementation(async (command) =>
    command.action === "staged" ? { state: { draft: "private" } } : null,
  );
  await c.ready;
  await settle();
  expect(stage).toHaveBeenCalledWith(offer, { draft: "private" }, expect.any(AbortSignal));
  expect(f.control).not.toHaveBeenCalledWith({ action: "acknowledge", id: "offer" });
  complete();
  await settle();
  expect(f.control).toHaveBeenCalledWith({ action: "acknowledge", id: "offer" });
  f.setSnapshot({ ...f.snapshot(), transfers: [{ offer, ready: true }] });
  f.changed();
  await settle();
  expect(f.control).toHaveBeenCalledWith({ action: "commit", id: "offer" });
  c.dispose();
});
it("cancels failed staging, does not commit stale work after disposal, and unsubscribes", async () => {
  const f = fixture();
  const error = new Error("staging failed");
  const stage = vi.fn().mockRejectedValue(error);
  const offer = {
    id: "offer",
    lease: { panelId: "connections", windowId: "other", generation: 1 },
    targetWindow: "main",
  };
  f.setSnapshot({ ...f.snapshot(), panels: [offer.lease], transfers: [{ offer, ready: false }] });
  f.control.mockImplementation(async (command) =>
    command.action === "staged" ? { state: {} } : null,
  );
  const c = startPanelWindowCoordinator(f.client, {
    panelIds: () => ["connections"],
    receive: f.receive,
    failure: f.failure,
    stage,
  });
  await c.ready;
  await settle();
  expect(f.control).toHaveBeenCalledWith({ action: "cancel", id: "offer" });
  expect(f.failure).toHaveBeenCalledWith(error);
  c.dispose();
  f.control.mockClear();
  f.changed();
  await settle();
  expect(f.control).not.toHaveBeenCalled();
  expect(f.stop).toHaveBeenCalledTimes(1);
});
it("rejects a satellite as coordinator and releases a late subscription after disposal", async () => {
  const f = fixture();
  expect(() =>
    startPanelWindowCoordinator(
      { ...f.client, windowId: "other" },
      { panelIds: () => [], receive: f.receive, failure: f.failure },
    ),
  ).toThrow("coordinatorRequired");
  let finish!: (stop: () => void) => void;
  f.client.subscribe = vi.fn(
    () =>
      new Promise<() => void>((resolve) => {
        finish = resolve;
      }),
  );
  const c = startPanelWindowCoordinator(f.client, {
    panelIds: () => [],
    receive: f.receive,
    failure: f.failure,
  });
  c.dispose();
  finish(f.stop);
  await c.ready;
  expect(f.control).not.toHaveBeenCalled();
  expect(f.stop).toHaveBeenCalledTimes(1);
});

it("does not block unrelated changes while staging and aborts a timed-out or disposed destination", async () => {
  const f = fixture();
  let complete!: () => void;
  let signal!: AbortSignal;
  const stage = vi.fn((_offer, _state, current: AbortSignal) => {
    signal = current;
    return new Promise<void>((resolve) => {
      complete = resolve;
    });
  });
  const offer = {
    id: "offer",
    lease: { panelId: "connections", windowId: "other", generation: 1 },
    targetWindow: "main",
  };
  f.setSnapshot({ ...f.snapshot(), panels: [offer.lease], transfers: [{ offer, ready: false }] });
  f.control.mockImplementation(async (command) =>
    command.action === "staged" ? { state: {} } : null,
  );
  const c = startPanelWindowCoordinator(f.client, {
    panelIds: () => ["connections"],
    receive: f.receive,
    failure: f.failure,
    stage,
  });
  await c.ready;
  await settle();
  expect(stage).toHaveBeenCalledTimes(1);
  f.setSnapshot({ ...f.snapshot(), transfers: [] });
  f.changed();
  await settle();
  expect(signal.aborted).toBe(true);
  complete();
  await settle();
  expect(f.control).not.toHaveBeenCalledWith({ action: "acknowledge", id: "offer" });
  expect(f.receive).toHaveBeenCalledTimes(2);
  c.dispose();
});

it("reconciles a cancelled acknowledged offer without a false error or a lost queued refresh", async () => {
  const f = fixture();
  const lease = { panelId: "tasks", windowId: "satellite", generation: 4 };
  f.setSnapshot({
    ...f.snapshot(),
    panels: [lease],
    transfers: [
      { offer: { id: "cancelled-after-ready", lease, targetWindow: "main" }, ready: true },
    ],
  });
  const original = f.control.getMockImplementation()!;
  f.control.mockImplementation(async (request) => {
    if (request.action === "commit") {
      f.setSnapshot({ ...f.snapshot(), transfers: [] });
      throw new Error("transfer expired");
    }
    return original(request);
  });
  const coordinator = startPanelWindowCoordinator(f.client, {
    panelIds: () => ["tasks"],
    receive: f.receive,
    failure: f.failure,
  });
  await coordinator.ready;
  await settle();
  expect(f.failure).not.toHaveBeenCalled();
  expect(f.receive.mock.lastCall?.[0].transfers).toEqual([]);
  expect(f.control.mock.calls.filter(([r]) => r.action === "commit")).toHaveLength(1);
  coordinator.dispose();
});

it("synchronizes plugin adapters only after panel registration and publishes a fresh approved snapshot", async () => {
  const f = fixture();
  const synchronize = vi.fn(async (snapshot: NativePanelSnapshot) => {
    expect(snapshot.panels.some((panel) => panel.panelId === "plugin:sample:files")).toBe(true);
    f.setSnapshot({ ...snapshot, pluginViews: [{ panelId: "plugin:sample:files" } as never] });
  });
  const c = startPanelWindowCoordinator(f.client, {
    panelIds: () => ["plugin:sample:files"],
    receive: f.receive,
    synchronize,
    failure: f.failure,
  });
  await c.ready;
  expect(synchronize).toHaveBeenCalledOnce();
  expect(f.receive).toHaveBeenCalledWith(
    expect.objectContaining({ pluginViews: [{ panelId: "plugin:sample:files" }] }),
  );
  expect(f.failure).not.toHaveBeenCalled();
  c.dispose();
});

it("drains a queued contribution-removal invalidation after an in-flight adapter review fails", async () => {
  const f = fixture();
  let fail!: (error: unknown) => void;
  const synchronize = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          fail = reject;
        }),
    )
    .mockResolvedValue(undefined);
  let ids = ["plugin:sample:files"];
  const c = startPanelWindowCoordinator(f.client, {
    panelIds: () => ids,
    receive: f.receive,
    synchronize,
    failure: f.failure,
  });
  await vi.waitFor(() => expect(synchronize).toHaveBeenCalledOnce());
  ids = [];
  f.changed();
  fail(new Error("plugin.notFound"));
  await c.ready;
  expect(f.failure).toHaveBeenCalledOnce();
  expect(synchronize).toHaveBeenCalledTimes(2);
  expect(f.snapshot().panels).toEqual([]);
  expect(f.receive).toHaveBeenLastCalledWith(expect.objectContaining({ panels: [] }));
  c.dispose();
});

it("uses resource registration before snapshot publication instead of addPanel for dynamic pages", async () => {
  const f = fixture();
  const id = "terminal:existing-session";
  const registerPanel = vi.fn(async (panelId: string) => {
    f.setSnapshot({
      ...f.snapshot(),
      panels: [{ panelId, windowId: "main", generation: 9 }],
      terminalViews: [{ panelId, allowMove: true }],
    });
  });
  const coordinator = startPanelWindowCoordinator(f.client, {
    panelIds: () => [id],
    registerPanel,
    receive: f.receive,
    failure: f.failure,
  });
  await coordinator.ready;
  expect(registerPanel).toHaveBeenCalledWith(id);
  expect(f.control).not.toHaveBeenCalledWith({ action: "addPanel", panelId: id });
  expect(f.receive).toHaveBeenCalledWith(
    expect.objectContaining({ terminalViews: [{ panelId: id, allowMove: true }] }),
  );
  expect(f.failure).not.toHaveBeenCalled();
  coordinator.dispose();
});

it.each([
  ["terminal:existing-session", "terminalViews"],
  ["sftp:existing-session", "filePages"],
  ["files:local-page", "filePages"],
  ["editor-view:existing-page", "editorPages"],
  ["host-view:existing-page", "hostPages"],
  ["settings-view:existing-page", "settingsPages"],
] as const)(
  "rebinds %s after document recreation even when its native lease survives",
  async (id, descriptor) => {
    const f = fixture();
    const lease = { panelId: id, windowId: "main", generation: 10 };
    // Native navigation rotates the document and leases; resource descriptors
    // disappear until the new coordinator binds the resource again.
    f.setSnapshot({ ...f.snapshot(), panels: [lease], [descriptor]: [] });
    const views = createWindowViews(f.client);
    const registerPanel = vi.fn(async () => {
      f.setSnapshot({ ...f.snapshot(), [descriptor]: [{ panelId: id, allowMove: true }] });
    });
    const pending: Promise<void>[] = [];
    const coordinator = startPanelWindowCoordinator(f.client, {
      panelIds: () => [id],
      registerPanel,
      receive: (snapshot) => pending.push(views.reconcile(snapshot)),
      failure: f.failure,
    });
    try {
      await coordinator.ready;
      await Promise.all(pending);
      expect(registerPanel).toHaveBeenCalledExactlyOnceWith(id);
      expect(useWindowViews.getState().entries.get(id)?.lease).toEqual(lease);
      expect(f.control).not.toHaveBeenCalledWith({ action: "addPanel", panelId: id });
      expect(f.control).not.toHaveBeenCalledWith({ action: "removePanel", panelId: id });
      await coordinator.refresh();
      expect(registerPanel).toHaveBeenCalledOnce();
      expect(f.failure).not.toHaveBeenCalled();
    } finally {
      coordinator.dispose();
      views.dispose();
    }
  },
);

it("keeps an already bound terminal satellite owner without rebinding or recreating it", async () => {
  const f = fixture();
  const id = "terminal:existing-session";
  const lease = { panelId: id, windowId: "satellite", generation: 12 };
  f.setSnapshot({
    ...f.snapshot(),
    panels: [lease],
    terminalViews: [{ panelId: id, allowMove: true }],
  });
  const registerPanel = vi.fn();
  const coordinator = startPanelWindowCoordinator(f.client, {
    panelIds: () => [id],
    registerPanel,
    receive: f.receive,
    failure: f.failure,
  });
  await coordinator.ready;
  expect(registerPanel).not.toHaveBeenCalled();
  expect(f.receive).toHaveBeenCalledWith(expect.objectContaining({ panels: [lease] }));
  expect(f.control).toHaveBeenCalledExactlyOnceWith({ action: "ready" });
  expect(f.failure).not.toHaveBeenCalled();
  coordinator.dispose();
});
