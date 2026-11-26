import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useFloatingPanel } from "@/components/layout/useFloatingPanel";

const saved = { x: 700, y: 400, width: 400, height: 300 };
afterEach(() => vi.restoreAllMocks());

it("never persists hidden/docked geometry during resize and clears inline geometry on docking", () => {
  const element = document.createElement("section");
  document.body.append(element);
  const panel = { current: element };
  const commit = vi.fn();
  const rect = vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
    ...saved,
    left: saved.x,
    top: saved.y,
    right: 1100,
    bottom: 700,
  } as DOMRect);
  const boxes = vi
    .spyOn(element, "getClientRects")
    .mockReturnValue([rect()] as unknown as DOMRectList);
  const view = renderHook(({ enabled }) => useFloatingPanel(panel, saved, commit, enabled), {
    initialProps: { enabled: true },
  });
  expect(element.style.left).not.toBe("");
  view.rerender({ enabled: false });
  expect(element.style.left).toBe("");
  act(() => window.dispatchEvent(new Event("resize")));
  expect(commit).not.toHaveBeenCalled();
  view.rerender({ enabled: true });
  boxes.mockReturnValue([] as unknown as DOMRectList);
  act(() => window.dispatchEvent(new Event("resize")));
  expect(commit).not.toHaveBeenCalled();
  boxes.mockReturnValue([rect()] as unknown as DOMRectList);
  vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  act(() => window.dispatchEvent(new Event("resize")));
  expect(commit).not.toHaveBeenCalled();
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  rect.mockReturnValue({ x: 0, y: 0, width: 0, height: 0 } as DOMRect);
  act(() => window.dispatchEvent(new Event("resize")));
  expect(commit).not.toHaveBeenCalled();
  rect.mockReturnValue({ ...saved } as DOMRect);
  act(() => window.dispatchEvent(new Event("resize")));
  expect(commit).toHaveBeenCalledOnce();
  expect(commit.mock.calls[0]![0].x).toBeGreaterThan(0);
  view.unmount();
  element.remove();
});

it("keeps the CSS bottom-right anchor on default open, resize and reopen", () => {
  const element = document.createElement("section");
  const commit = vi.fn();
  const view = renderHook(
    ({ enabled }) => useFloatingPanel({ current: element }, null, commit, enabled),
    {
      initialProps: { enabled: true },
    },
  );
  act(() => window.dispatchEvent(new Event("resize")));
  view.rerender({ enabled: false });
  view.rerender({ enabled: true });
  expect(element.style.left).toBe("");
  expect(element.style.top).toBe("");
  expect(commit).not.toHaveBeenCalled();
});
