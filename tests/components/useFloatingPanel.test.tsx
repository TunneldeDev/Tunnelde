import { useRef } from "react";
import { act, fireEvent, render, renderHook } from "@testing-library/react";
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

function pointer(type: string, x: number, y: number, buttons = 1) {
  const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0, buttons });
  Object.defineProperty(event, "pointerId", { value: 1 });
  return event;
}
function draggable() {
  const initial = { x: 40, y: 60, width: 400, height: 300 };
  const commit = vi.fn();
  function Harness({ enabled }: { enabled: boolean }) {
    const panel = useRef<HTMLElement>(null);
    const geometry = useFloatingPanel(panel, initial, commit, enabled);
    return (
      <section ref={panel}>
        <button {...geometry.handle("se")}>Resize</button>
        <p>Retained</p>
      </section>
    );
  }
  const view = render(<Harness enabled />);
  const handle = view.getByRole("button", { name: "Resize" });
  const panel = handle.parentElement!;
  vi.spyOn(panel, "getBoundingClientRect").mockReturnValue({
    ...initial,
    left: 40,
    top: 60,
    right: 440,
    bottom: 360,
  } as DOMRect);
  Object.assign(handle, {
    setPointerCapture: vi.fn(),
    hasPointerCapture: () => true,
    releasePointerCapture: vi.fn(),
  });
  return {
    ...view,
    handle,
    panel,
    commit,
    disable: () => view.rerender(<Harness enabled={false} />),
  };
}
it("commits the exact release position even before a preview frame or move event", () => {
  vi.spyOn(window, "requestAnimationFrame").mockReturnValue(42);
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  const f = draggable();
  const content = f.getByText("Retained");
  fireEvent(f.handle, pointer("pointerdown", 440, 360));
  fireEvent(window, pointer("pointermove", 450, 370));
  expect(f.commit).not.toHaveBeenCalled();
  fireEvent(window, pointer("pointerup", 500, 420, 0));
  expect(f.commit).toHaveBeenCalledExactlyOnceWith({ x: 40, y: 60, width: 460, height: 360 });
  expect(f.panel.style.width).toBe("460px");
  expect(f.getByText("Retained")).toBe(content);
  fireEvent(f.handle, pointer("lostpointercapture", 500, 420, 0));
  expect(f.commit).toHaveBeenCalledOnce();
});
it("supports release-only resize and restores the cursor and text selection", () => {
  const f = draggable();
  const cursor = document.body.style.cursor,
    selection = document.body.style.userSelect;
  fireEvent(f.handle, pointer("pointerdown", 440, 360));
  fireEvent(window, pointer("pointerup", 520, 400, 0));
  expect(f.commit).toHaveBeenCalledExactlyOnceWith({ x: 40, y: 60, width: 480, height: 340 });
  expect(document.body.style.cursor).toBe(cursor);
  expect(document.body.style.userSelect).toBe(selection);
});
it.each(["Escape", "blur", "pointercancel", "lostpointercapture", "disable", "unmount"])(
  "rolls back floating resize on %s",
  (reason) => {
    vi.spyOn(window, "requestAnimationFrame").mockReturnValue(42);
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    const f = draggable();
    fireEvent(f.handle, pointer("pointerdown", 440, 360));
    fireEvent(window, pointer("pointermove", 500, 420));
    if (reason === "Escape") fireEvent.keyDown(window, { key: "Escape" });
    else if (reason === "blur") fireEvent(window, new Event("blur"));
    else if (reason === "disable") f.disable();
    else if (reason === "unmount") f.unmount();
    else fireEvent(f.handle, pointer(reason, 500, 420, 0));
    fireEvent(window, pointer("pointerup", 520, 440, 0));
    expect(f.commit).not.toHaveBeenCalled();
    expect(document.body.style.cursor).not.toBe("se-resize");
    if (reason === "disable") expect(f.panel.style.width).toBe("");
    else if (reason !== "unmount") expect(f.panel.style.width).toBe("400px");
  },
);
