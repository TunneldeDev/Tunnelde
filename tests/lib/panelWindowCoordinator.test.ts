import { expect, it, vi } from "vitest";
import { startPanelWindowCoordinator } from "@/lib/panels/windowCoordinator";
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
