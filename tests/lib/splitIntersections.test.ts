import { expect, it } from "vitest";
import {
  splitIntersections,
  resizeIntersection,
  type SplitSegment,
} from "@/lib/layout/intersections";
const vertical: SplitSegment = {
  id: "vertical",
  direction: "row",
  x: 500,
  y: 0,
  width: 4,
  height: 800,
};
const left: SplitSegment = { id: "left", direction: "column", x: 0, y: 400, width: 500, height: 4 };
it("recognizes T and cross junctions and joins only actual touching segments", () => {
  expect(splitIntersections([vertical, left])).toEqual([
    { id: "left|vertical", x: 502, y: 402, splits: ["vertical", "left"] },
  ]);
  const right = { ...left, id: "right", x: 504, width: 500 };
  const unrelated = { ...left, id: "unrelated", y: 100, width: 100 };
  expect(splitIntersections([vertical, left, right, unrelated])[0]?.splits.sort()).toEqual([
    "left",
    "right",
    "vertical",
  ]);
  const separated = splitIntersections([vertical, left, { ...right, y: 500 }]);
  expect(separated).toHaveLength(2);
  expect(splitIntersections([{ ...vertical, height: 100 }, left])).toEqual([]);
  expect(splitIntersections([{ ...vertical, height: 0 }, left])).toEqual([]);
});
it("clamps the common displacement using every participant's own bounds and size", () => {
  const items = [
    { id: "x", direction: "row" as const, ratio: 0.5, size: 1000, min: 0.15, max: 0.85 },
    { id: "left", direction: "column" as const, ratio: 0.5, size: 800, min: 0.15, max: 0.85 },
    { id: "right", direction: "column" as const, ratio: 0.5, size: 400, min: 0.2, max: 0.8 },
  ];
  expect(resizeIntersection(items, 100, 80)).toEqual({ x: 0.6, left: 0.6, right: 0.7 });
  const clamped = resizeIntersection(items, -1000, 1000);
  expect(clamped.x).toBeCloseTo(0.15);
  expect(clamped.left).toBeCloseTo(0.65);
  expect(clamped.right).toBeCloseTo(0.8);
  expect(resizeIntersection(items, NaN, Infinity)).toEqual({ x: 0.5, left: 0.5, right: 0.5 });
});
