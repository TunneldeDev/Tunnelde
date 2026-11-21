import { expect, it, vi } from "vitest";
import type { WindowViews } from "@/lib/panels/windowViews";
import { movePanelToWindow } from "@/lib/panels/windowMoves";
const mock = vi.hoisted(() => ({ views: undefined as unknown as WindowViews }));
vi.mock("@/lib/panels/windowViews", () => ({
  windowViews: () => mock.views,
  transferablePanel: () => true,
}));
function fixture(fail = false) {
  const lease = { panelId: "connections", windowId: "main", generation: 1 };
  const snapshot = vi
    .fn()
    .mockResolvedValueOnce({ panels: [lease], windows: [], transfers: [] })
    .mockResolvedValue({
      panels: [{ ...lease, windowId: "target", generation: 2 }],
      windows: [],
      transfers: [],
    });
  const control = fail
    ? vi.fn().mockRejectedValue(new Error("blocked"))
    : vi.fn().mockResolvedValue({ id: "offer" });
  const setMoving = vi.fn();
  mock.views = {
    client: { windowId: "main", snapshot, control },
    setMoving,
    captureForMove: vi.fn().mockReturnValue({ version: 1 }),
  } as unknown as WindowViews;
  return { setMoving };
}
it("keeps the retired source inert until its asynchronous React owner actually unmounts", async () => {
  const { setMoving } = fixture();
  await movePanelToWindow("connections", "target");
  expect(setMoving.mock.calls).toEqual([
    ["connections", true, { panelId: "connections", windowId: "main", generation: 1 }],
  ]);
});
it("unfreezes the existing source on failure instead of leaving it stranded", async () => {
  const { setMoving } = fixture(true);
  await expect(movePanelToWindow("connections", "target")).rejects.toThrow("blocked");
  expect(setMoving.mock.calls).toEqual([
    ["connections", true, { panelId: "connections", windowId: "main", generation: 1 }],
    ["connections", false, { panelId: "connections", windowId: "main", generation: 1 }],
  ]);
});

it("can detach again from a satellite using its own exact lease, not coordinator authority", async () => {
  const lease = { panelId: "tasks", windowId: "satellite-one", generation: 9 };
  const create = vi.fn().mockResolvedValue("destination"),
    control = vi.fn().mockResolvedValue({ id: "offer" });
  const snapshot = vi
    .fn()
    .mockResolvedValueOnce({ panels: [lease], windows: [], transfers: [] })
    .mockResolvedValueOnce({
      panels: [lease],
      windows: [{ id: "destination", ready: true }],
      transfers: [],
    })
    .mockResolvedValue({
      panels: [{ ...lease, windowId: "destination", generation: 10 }],
      windows: [],
      transfers: [],
    });
  mock.views = {
    client: { windowId: "satellite-one", create, snapshot, control },
    captureForMove: vi.fn().mockReturnValue({ version: 1 }),
    setMoving: vi.fn(),
  } as unknown as WindowViews;
  await movePanelToWindow("tasks");
  expect(create).toHaveBeenCalledExactlyOnceWith(lease);
  expect(control).toHaveBeenCalledWith({
    action: "prepare",
    lease,
    targetWindow: "destination",
    state: { version: 1 },
  });
});
it("cleans up only the destination it created when handoff preparation fails", async () => {
  const lease = { panelId: "tasks", windowId: "satellite-one", generation: 9 };
  const destroy = vi.fn().mockResolvedValue(undefined);
  mock.views = {
    client: {
      windowId: "satellite-one",
      create: vi.fn().mockResolvedValue("abandoned"),
      snapshot: vi.fn().mockResolvedValue({
        panels: [lease],
        windows: [{ id: "abandoned", ready: true }],
        transfers: [],
      }),
      control: vi.fn().mockRejectedValue(new Error("blocked")),
      destroy,
    },
    captureForMove: vi.fn().mockReturnValue({ version: 1 }),
    setMoving: vi.fn(),
  } as unknown as WindowViews;
  await expect(movePanelToWindow("tasks")).rejects.toThrow("blocked");
  expect(destroy).toHaveBeenCalledExactlyOnceWith("abandoned");
});

it("does not silently move a newer lease incarnation after a native drag release", async () => {
  fixture();
  await expect(
    movePanelToWindow("connections", "target", {
      panelId: "connections",
      windowId: "main",
      generation: 99,
    }),
  ).rejects.toThrow("panel.window.staleOwner");
  expect(mock.views.captureForMove).not.toHaveBeenCalled();
  expect(mock.views.client.control).not.toHaveBeenCalled();
});

it("uses the host-bound source job instead of accepting a plugin supplied lease or destination in prepare", async () => {
  fixture();
  const lease = { panelId: "connections", windowId: "main", generation: 1 };
  await movePanelToWindow("connections", "target", lease, "native-operation");
  expect(mock.views.client.control).toHaveBeenCalledExactlyOnceWith({
    action: "preparePanelMove",
    id: "native-operation",
    state: { version: 1 },
  });
});

it("does not prepare before async capture completes, and cancellation cannot submit that late capsule", async () => {
  fixture();
  let finish!: (state: unknown) => void;
  vi.mocked(mock.views.captureForMove).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = (value) => resolve(value as Awaited<ReturnType<WindowViews["captureForMove"]>>);
      }),
  );
  const abort = new AbortController();
  const pending = movePanelToWindow("connections", "target", undefined, undefined, abort.signal);
  const check = expect(pending).rejects.toThrow("cancelled");
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(mock.views.client.control).not.toHaveBeenCalled();
  abort.abort();
  finish({ version: 1 });
  await check;
  expect(mock.views.client.control).not.toHaveBeenCalled();
  expect(mock.views.setMoving).toHaveBeenLastCalledWith("connections", false, {
    panelId: "connections",
    windowId: "main",
    generation: 1,
  });
});

it("cancels an already prepared offer when its waiter aborts, without unfreezing a committed destination", async () => {
  fixture();
  const lease = { panelId: "connections", windowId: "main", generation: 1 };
  const abort = new AbortController();
  vi.mocked(mock.views.client.snapshot)
    .mockReset()
    .mockResolvedValue({
      panels: [lease],
      windows: [],
      transfers: [{ offer: { id: "offer", lease, targetWindow: "target" }, ready: false }],
    });
  vi.mocked(mock.views.client.control).mockImplementationOnce(async () => {
    abort.abort();
    return { id: "offer" };
  });
  await expect(
    movePanelToWindow("connections", "target", undefined, undefined, abort.signal),
  ).rejects.toThrow("cancelled");
  expect(mock.views.client.control).toHaveBeenLastCalledWith({ action: "cancel", id: "offer" });
  expect(mock.views.setMoving).toHaveBeenLastCalledWith("connections", false, lease);
});
it("a commit already observed wins a racing cancellation and keeps the retired source inert", async () => {
  fixture();
  const abort = new AbortController();
  vi.mocked(mock.views.client.control).mockImplementationOnce(async () => {
    abort.abort();
    return { id: "offer" };
  });
  await movePanelToWindow("connections", "target", undefined, undefined, abort.signal);
  expect(mock.views.setMoving).toHaveBeenCalledTimes(1);
  expect(mock.views.client.control).not.toHaveBeenCalledWith({ action: "cancel", id: "offer" });
});
