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
