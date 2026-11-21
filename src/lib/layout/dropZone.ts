export type PanelDropZone = "left" | "right" | "top" | "bottom";
/** Center merges, edges split by the nearest boundary. Shared by main/satellite. */
export function panelDropZone(
  element: Element,
  point: { clientX: number; clientY: number },
): PanelDropZone | null {
  const rect = element.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const x = (point.clientX - rect.left) / rect.width,
    y = (point.clientY - rect.top) / rect.height;
  if (x >= 0.375 && x <= 0.625 && y >= 0.375 && y <= 0.625) return null;
  const distances: [PanelDropZone, number][] = [
    ["left", x],
    ["right", 1 - x],
    ["top", y],
    ["bottom", 1 - y],
  ];
  return distances.reduce((best, candidate) => (candidate[1] < best[1] ? candidate : best))[0];
}
