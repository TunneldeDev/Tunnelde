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
    capture: vi.fn().mockReturnValue({ version: 1 }),
  } as unknown as WindowViews;
  return { setMoving };
}
it("keeps the retired source inert until its asynchronous React owner actually unmounts", async () => {
  const { setMoving } = fixture();
  await movePanelToWindow("connections", "target");
  expect(setMoving.mock.calls).toEqual([["connections", true]]);
});
it("unfreezes the existing source on failure instead of leaving it stranded", async () => {
  const { setMoving } = fixture(true);
  await expect(movePanelToWindow("connections", "target")).rejects.toThrow("blocked");
  expect(setMoving.mock.calls).toEqual([
    ["connections", true],
    ["connections", false],
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
    capture: vi.fn().mockReturnValue({ version: 1 }),
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
    capture: vi.fn().mockReturnValue({ version: 1 }),
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
  expect(mock.views.capture).not.toHaveBeenCalled();
  expect(mock.views.client.control).not.toHaveBeenCalled();
});
