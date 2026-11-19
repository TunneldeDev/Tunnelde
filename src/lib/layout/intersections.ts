import type { SplitDirection } from "./types";

export interface SplitSegment {
  id: string;
  direction: SplitDirection;
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface SplitIntersection {
  id: string;
  x: number;
  y: number;
  splits: string[];
}

/** Actual touching perpendicular separator segments, not arbitrary aligned split IDs. */
export function splitIntersections(segments: SplitSegment[]): SplitIntersection[] {
  const result: SplitIntersection[] = [];
  for (const vertical of segments.filter((item) => item.direction === "row")) {
    for (const horizontal of segments.filter((item) => item.direction === "column")) {
      const x = vertical.x + vertical.width / 2;
      const y = horizontal.y + horizontal.height / 2;
      if (
        vertical.height <= 0 ||
        horizontal.width <= 0 ||
        x < horizontal.x - vertical.width / 2 - 1 ||
        x > horizontal.x + horizontal.width + vertical.width / 2 + 1 ||
        y < vertical.y - horizontal.height / 2 - 1 ||
        y > vertical.y + vertical.height + horizontal.height / 2 + 1
      )
        continue;
      const nearby = result.find(
        (point) =>
          Math.abs(point.x - x) <= Math.max(vertical.width, 4) &&
          Math.abs(point.y - y) <= Math.max(horizontal.height, 4),
      );
      if (nearby) nearby.splits = [...new Set([...nearby.splits, vertical.id, horizontal.id])];
      else result.push({ id: "", x, y, splits: [vertical.id, horizontal.id] });
    }
  }
  return result.map((point) => ({ ...point, id: [...point.splits].sort().join("|") }));
}

export interface ResizeParticipant {
  id: string;
  direction: SplitDirection;
  ratio: number;
  size: number;
  min: number;
  max: number;
}
/** Clamp the shared displacement, so touching collinear segments remain aligned. */
export function resizeIntersection(items: ResizeParticipant[], dx: number, dy: number) {
  const delta = { row: Number.isFinite(dx) ? dx : 0, column: Number.isFinite(dy) ? dy : 0 };
  for (const direction of ["row", "column"] as const) {
    const axis = items.filter((item) => item.direction === direction && item.size > 0);
    const min = Math.max(...axis.map((item) => (item.min - item.ratio) * item.size));
    const max = Math.min(...axis.map((item) => (item.max - item.ratio) * item.size));
    delta[direction] = Math.max(min, Math.min(max, delta[direction]));
  }
  return Object.fromEntries(
    items
      .filter((item) => item.size > 0)
      .map((item) => [item.id, item.ratio + delta[item.direction] / item.size]),
  );
}
