export interface FloatingRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type FloatingAction = "move" | "n" | "e" | "s" | "w" | "ne" | "nw" | "se" | "sw";

export function isFloatingRect(value: unknown): value is FloatingRect {
  if (!value || typeof value !== "object") return false;
  const rect = value as FloatingRect;
  return (
    [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) &&
    rect.width > 0 &&
    rect.height > 0
  );
}

export function clampFloatingRect(rect: FloatingRect, area: FloatingRect): FloatingRect {
  const width = Math.min(area.width, Math.max(Math.min(320, area.width), rect.width));
  const height = Math.min(area.height, Math.max(Math.min(160, area.height), rect.height));
  return {
    x: Math.min(area.x + area.width - width, Math.max(area.x, rect.x)),
    y: Math.min(area.y + area.height - height, Math.max(area.y, rect.y)),
    width,
    height,
  };
}

export function adjustFloatingRect(
  start: FloatingRect,
  action: FloatingAction,
  dx: number,
  dy: number,
  area: FloatingRect,
): FloatingRect {
  if (action === "move")
    return clampFloatingRect({ ...start, x: start.x + dx, y: start.y + dy }, area);
  const right = start.x + start.width;
  const bottom = start.y + start.height;
  const minWidth = Math.min(320, area.width);
  const minHeight = Math.min(160, area.height);
  const left = action.includes("w")
    ? Math.max(area.x, Math.min(right - minWidth, start.x + dx))
    : start.x;
  const top = action.includes("n")
    ? Math.max(area.y, Math.min(bottom - minHeight, start.y + dy))
    : start.y;
  const endX = action.includes("e")
    ? Math.min(area.x + area.width, Math.max(left + minWidth, right + dx))
    : right;
  const endY = action.includes("s")
    ? Math.min(area.y + area.height, Math.max(top + minHeight, bottom + dy))
    : bottom;
  return clampFloatingRect({ x: left, y: top, width: endX - left, height: endY - top }, area);
}
