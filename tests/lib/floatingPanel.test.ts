import { describe, expect, it } from "vitest";
import {
  adjustFloatingRect,
  clampFloatingRect,
  isFloatingRect,
  type FloatingAction,
} from "@/lib/layout/floatingPanel";

const area = { x: 8, y: 42, width: 984, height: 718 };
const rect = { x: 300, y: 200, width: 460, height: 300 };

describe("floating panel geometry", () => {
  it("keeps every edge visible after a viewport shrink, including below minimum size", () => {
    expect(
      clampFloatingRect(
        { x: 900, y: 700, width: 600, height: 500 },
        { x: 8, y: 42, width: 280, height: 120 },
      ),
    ).toEqual({ x: 8, y: 42, width: 280, height: 120 });
  });

  it("anchors opposite edges when resizing past the minimum or viewport", () => {
    for (const delta of [-10000, 10000]) {
      const resized = adjustFloatingRect(rect, "nw", delta, delta, area);
      expect(resized.x + resized.width).toBe(rect.x + rect.width);
      expect(resized.y + resized.height).toBe(rect.y + rect.height);
      expect(resized.width).toBeGreaterThanOrEqual(320);
      expect(resized.height).toBeGreaterThanOrEqual(160);
    }
  });

  it("keeps all eight resize directions and moves inside the usable workbench", () => {
    for (const action of ["move", "n", "e", "s", "w", "ne", "nw", "se", "sw"] as FloatingAction[]) {
      for (const dx of [-10000, -50, 0, 50, 10000]) {
        for (const dy of [-10000, -50, 0, 50, 10000]) {
          const next = adjustFloatingRect(rect, action, dx, dy, area);
          expect(next.x).toBeGreaterThanOrEqual(area.x);
          expect(next.y).toBeGreaterThanOrEqual(area.y);
          expect(next.x + next.width).toBeLessThanOrEqual(area.x + area.width);
          expect(next.y + next.height).toBeLessThanOrEqual(area.y + area.height);
          if (action === "move")
            expect([next.width, next.height]).toEqual([rect.width, rect.height]);
        }
      }
    }
  });

  it("rejects corrupted persisted layouts", () => {
    for (const invalid of [
      null,
      {},
      { ...rect, x: Infinity },
      { ...rect, width: -1 },
      { ...rect, height: "300" },
    ]) {
      expect(isFloatingRect(invalid)).toBe(false);
    }
    expect(isFloatingRect(rect)).toBe(true);
  });
});
