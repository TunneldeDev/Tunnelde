import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { paneRender } = vi.hoisted(() => ({ paneRender: vi.fn() }));
vi.mock("@/components/layout/PaneView", () => ({
  PaneView: ({ pane }: { pane: { id: string } }) => {
    paneRender(pane.id);
    return <div>{pane.id}</div>;
  },
}));

import { PaneLayout } from "@/components/layout/PaneLayout";
import { useWorkspace, type SplitDirection, type WorkspaceLayout } from "@/store/workspace";

function pointer(
  target: HTMLElement | Window,
  type: string,
  x: number,
  y = 100,
  id = 1,
  buttons = 1,
) {
  const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, buttons });
  Object.defineProperty(event, "pointerId", { value: id });
  fireEvent(target, event);
}

function setup(direction: SplitDirection = "row") {
  useWorkspace.setState({
    tabs: [],
    panes: [
      { id: "one", tabIds: [], activeId: null },
      { id: "two", tabIds: [], activeId: null },
    ],
    layout: {
      kind: "split",
      id: "test-split",
      ratio: 0.5,
      direction,
      first: { kind: "pane", paneId: "one" },
      second: { kind: "pane", paneId: "two" },
    },
    activePaneId: "one",
    activeId: null,
  });
  const resize = vi.spyOn(useWorkspace.getState(), "resizeSplit");
  const view = render(<PaneLayout />);
  const panel = view.container.querySelector<HTMLElement>(".pane-layout")!;
  const handle = screen.getByRole("separator");
  vi.spyOn(panel, "getBoundingClientRect").mockReturnValue({ width: 1004, height: 604 } as DOMRect);
  vi.spyOn(handle, "getBoundingClientRect").mockReturnValue({ width: 4, height: 4 } as DOMRect);
  Object.assign(handle, { setPointerCapture: vi.fn(), hasPointerCapture: () => false });
  const frame = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(42);
  return { ...view, panel, handle, resize, frame };
}

function ratio() {
  const layout = useWorkspace.getState().layout;
  return layout.kind === "split" ? layout.ratio : null;
}

beforeEach(() => {
  paneRender.mockClear();
});

describe("workspace split resizing", () => {
  it.each<SplitDirection>(["row", "column"])(
    "previews %s geometry once per frame without changing layout or rendering panes, then saves the final release",
    (direction) => {
      const { panel, handle, resize, frame } = setup(direction);
      const before = paneRender.mock.calls.length;
      pointer(handle, "pointerdown", 500, 300);
      for (let i = 1; i <= 50; i++) pointer(window, "pointermove", 500 + i, 300 + i);
      expect(frame).toHaveBeenCalledTimes(1);
      act(() => frame.mock.calls[0]![0](0));
      expect(Number(panel.style.getPropertyValue("--td-split-ratio"))).toBeCloseTo(
        0.5 + 50 / (direction === "row" ? 1000 : 600),
      );
      expect(resize).not.toHaveBeenCalled();
      expect(ratio()).toBe(0.5);
      expect(paneRender).toHaveBeenCalledTimes(before);
      pointer(window, "pointerup", 600, 400, 1, 0);
      expect(resize).toHaveBeenCalledExactlyOnceWith(
        "test-split",
        0.5 + 100 / (direction === "row" ? 1000 : 600),
      );
      expect(Number(panel.style.getPropertyValue("--td-split-ratio"))).toBeCloseTo(ratio()!);
    },
  );

  it.each(["Escape", "blur", "pointercancel", "lostpointercapture"])(
    "discards a preview on %s and ignores the later release",
    (reason) => {
      const { panel, handle, frame, resize } = setup();
      pointer(handle, "pointerdown", 500);
      pointer(window, "pointermove", 600);
      act(() => frame.mock.calls[0]![0](0));
      expect(panel.style.getPropertyValue("--td-split-ratio")).toBe("0.6");
      if (reason === "Escape") fireEvent.keyDown(window, { key: "Escape" });
      else if (reason === "blur") fireEvent.blur(window);
      else pointer(reason === "lostpointercapture" ? handle : window, reason, 600);
      expect(panel.style.getPropertyValue("--td-split-ratio")).toBe("0.5");
      expect(handle.getAttribute("aria-valuenow")).toBe("50");
      pointer(window, "pointerup", 700, 100, 1, 0);
      expect(resize).not.toHaveBeenCalled();
    },
  );

  it("preserves a keyboard-committed ratio when cancelling an overlapping pointer gesture", () => {
    const { panel, handle, frame, resize } = setup();
    pointer(handle, "pointerdown", 500);
    pointer(window, "pointermove", 600);
    act(() => frame.mock.calls[0]![0](0));
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(ratio()).toBe(0.55);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(panel.style.getPropertyValue("--td-split-ratio")).toBe("0.55");
    pointer(window, "pointerup", 700, 100, 1, 0);
    expect(resize).toHaveBeenCalledTimes(1);
  });

  it("ignores other pointers and saves release coordinates even without a preceding move", () => {
    const { handle, resize } = setup();
    pointer(handle, "pointerdown", 500);
    pointer(window, "pointermove", 800, 100, 2);
    pointer(window, "pointerup", 800, 100, 2, 0);
    expect(resize).not.toHaveBeenCalled();
    pointer(window, "pointerup", 700, 100, 1, 0);
    expect(resize).toHaveBeenCalledExactlyOnceWith("test-split", 0.7);
  });

  it("cancels pending work when unmounted or when the split is replaced", () => {
    const { handle, resize, unmount } = setup();
    const cancel = vi.spyOn(window, "cancelAnimationFrame");
    pointer(handle, "pointerdown", 500);
    pointer(window, "pointermove", 600);
    const next: WorkspaceLayout = { kind: "pane", paneId: "one" };
    act(() => useWorkspace.setState({ layout: next }));
    pointer(window, "pointerup", 700, 100, 1, 0);
    expect(resize).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledWith(42);
    unmount();
  });

  it("does not write for a click without movement and clamps extreme drag positions", () => {
    const { handle, resize } = setup();
    pointer(handle, "pointerdown", 500);
    pointer(window, "pointerup", 500, 100, 1, 0);
    expect(resize).not.toHaveBeenCalled();
    pointer(handle, "pointerdown", 500);
    pointer(window, "pointerup", 9000, 100, 1, 0);
    expect(ratio()).toBe(0.85);
    pointer(handle, "pointerdown", 500);
    pointer(window, "pointerup", -9000, 100, 1, 0);
    expect(ratio()).toBe(0.15);
    fireEvent.doubleClick(handle);
    expect(ratio()).toBe(0.5);
  });
});
