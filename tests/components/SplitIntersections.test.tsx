import "@/i18n/i18n";
import { createPortal } from "react-dom";
import { SplitGeometryScope } from "@/components/ui/layout/SplitGeometry";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PanelLayout } from "@/components/ui/layout/PanelLayout";
import { PaneLayout } from "@/components/layout/PaneLayout";
import { useWorkspace } from "@/store/workspace";
import { viewIsBusy } from "@/lib/session/viewState";
import type { PanelLayoutNode } from "@/lib/layout/types";

vi.mock("@/components/layout/PaneView", () => ({
  PaneView: ({ pane }: { pane: { id: string } }) => <div>{pane.id}</div>,
}));

const leaf = (paneId: string): PanelLayoutNode => ({ kind: "pane", paneId });
const tree: PanelLayoutNode = {
  kind: "split",
  id: "outer",
  direction: "row",
  ratio: 0.5,
  first: {
    kind: "split",
    id: "left",
    direction: "column",
    ratio: 0.5,
    first: leaf("a"),
    second: leaf("b"),
  },
  second: {
    kind: "split",
    id: "right",
    direction: "column",
    ratio: 0.5,
    first: leaf("c"),
    second: leaf("d"),
  },
};
function pointer(
  target: Element | Window,
  type: string,
  x: number,
  y: number,
  id = 1,
  buttons = 1,
) {
  const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y, buttons });
  Object.defineProperty(event, "pointerId", { value: id });
  fireEvent(target, event);
}
function rect(x: number, y: number, width: number, height: number): DOMRect {
  return {
    x,
    y,
    left: x,
    top: y,
    width,
    height,
    right: x + width,
    bottom: y + height,
    toJSON: () => ({}),
  } as DOMRect;
}
function mockGeometry(container: HTMLElement) {
  const panels = Object.fromEntries(
    ["outer", "left", "right"].map((id) => [
      id,
      container.querySelector<HTMLElement>(`[data-split-id="${id}"]`)!,
    ]),
  );
  const ratio = (id: string) => Number(panels[id]!.style.getPropertyValue("--td-split-ratio"));
  const x = () => ratio("outer") * 1000;
  for (const id of ["outer", "left", "right"]) {
    const panel = panels[id]!;
    const separator = panel.querySelector<HTMLElement>(":scope > [role=separator]")!;
    vi.spyOn(panel, "getBoundingClientRect").mockImplementation(() =>
      id === "outer"
        ? rect(0, 0, 1004, 804)
        : id === "left"
          ? rect(0, 0, x(), 804)
          : rect(x() + 4, 0, 1000 - x(), 804),
    );
    vi.spyOn(separator, "getBoundingClientRect").mockImplementation(() =>
      id === "outer"
        ? rect(x(), 0, 4, 804)
        : rect(id === "left" ? 0 : x() + 4, ratio(id) * 800, id === "left" ? x() : 1000 - x(), 4),
    );
  }
  return { panels, ratio };
}
function setup() {
  const batch = vi.fn(),
    single = vi.fn(),
    pane = vi.fn((id: string) => <input aria-label={id} defaultValue="draft" />);
  const view = render(
    <PanelLayout
      layout={tree}
      renderPane={pane}
      onResize={single}
      onResizeMany={batch}
      resizeLabel="Resize"
    />,
  );
  const geometry = mockGeometry(view.container);
  act(() => {
    vi.advanceTimersByTime(20);
  });
  return {
    ...view,
    ...geometry,
    batch,
    single,
    pane,
    handle: screen.getByRole("button", { name: "Resize intersecting panels" }),
  };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("previews a cross in both axes without remounting or persisting, then commits one batch", () => {
  const { handle, ratio, batch, single, pane } = setup();
  const calls = pane.mock.calls.length;
  const input = screen.getByRole("textbox", { name: "a" });
  fireEvent.change(input, { target: { value: "retained" } });
  pointer(handle, "pointerdown", 502, 402);
  expect(viewIsBusy()).toBe(true);
  pointer(window, "pointermove", 602, 482);
  act(() => {
    vi.advanceTimersByTime(16);
  });
  expect(ratio("outer")).toBeCloseTo(0.6);
  expect(ratio("left")).toBeCloseTo(0.6);
  expect(ratio("right")).toBeCloseTo(0.6);
  expect(batch).not.toHaveBeenCalled();
  expect(single).not.toHaveBeenCalled();
  expect(pane.mock.calls).toHaveLength(calls);
  pointer(window, "pointerup", 602, 482);
  expect(batch).toHaveBeenCalledExactlyOnceWith({ outer: 0.6, left: 0.6, right: 0.6 });
  expect(screen.getByRole("textbox", { name: "a" })).toBe(input);
  expect(input).toHaveProperty("value", "retained");
  expect(document.body.style.cursor).toBe("");
  expect(viewIsBusy()).toBe(false);
});
it.each(["Escape", "pointercancel", "blur"])("rolls back both axes on %s", (reason) => {
  const { handle, ratio, batch } = setup();
  pointer(handle, "pointerdown", 502, 402);
  pointer(window, "pointermove", 602, 482);
  act(() => {
    vi.advanceTimersByTime(16);
  });
  if (reason === "Escape") fireEvent.keyDown(window, { key: "Escape" });
  else if (reason === "blur") fireEvent(window, new Event("blur"));
  else pointer(window, reason, 602, 482);
  for (const id of ["outer", "left", "right"]) expect(ratio(id)).toBe(0.5);
  expect(batch).not.toHaveBeenCalled();
  expect(viewIsBusy()).toBe(false);
});
it("supports directional precision keys, reset, unrelated pointer isolation and teardown", () => {
  const { handle, batch, unmount } = setup();
  fireEvent.keyDown(handle, { key: "ArrowRight", shiftKey: true });
  expect(batch).toHaveBeenCalledExactlyOnceWith({ outer: 0.501 });
  batch.mockClear();
  fireEvent.keyDown(handle, { key: "ArrowDown", isComposing: true });
  expect(batch).not.toHaveBeenCalled();
  pointer(handle, "pointerdown", 502, 402);
  pointer(window, "pointerup", 900, 700, 2);
  expect(viewIsBusy()).toBe(true);
  pointer(window, "pointercancel", 502, 402);
  fireEvent.doubleClick(handle);
  expect(batch).not.toHaveBeenCalled(); // already at the reset ratios
  pointer(handle, "pointerdown", 502, 402);
  unmount();
  expect(document.body.style.cursor).toBe("");
  expect(viewIsBusy()).toBe(false);
});
it("updates the workspace split tree and its subscribers in one transaction", () => {
  useWorkspace.setState({
    layout: tree,
    panes: ["a", "b", "c", "d"].map((id) => ({ id, tabIds: [], activeId: null })),
    tabs: [],
    activePaneId: "a",
    activeId: null,
  });
  // Keep panes visible to the adapter, like real retained workspace tabs.
  useWorkspace.setState({
    tabs: ["a", "b", "c", "d"].map((id) => ({
      id,
      kind: "welcome" as const,
      title: id,
      hostId: null,
      pinned: false,
    })),
    panes: ["a", "b", "c", "d"].map((id) => ({ id, tabIds: [id], activeId: id })),
  });
  const view = render(<PaneLayout />);
  mockGeometry(view.container);
  act(() => {
    vi.advanceTimersByTime(20);
  });
  const changes = vi.fn();
  const stop = useWorkspace.subscribe(changes);
  const handle = screen.getByRole("button", { name: "Resize intersecting panels" });
  pointer(handle, "pointerdown", 502, 402);
  pointer(window, "pointerup", 602, 482);
  expect(changes).toHaveBeenCalledTimes(1);
  expect(useWorkspace.getState().layout).toMatchObject({
    ratio: 0.6,
    first: { ratio: 0.6 },
    second: { ratio: 0.6 },
  });
  stop();
});

it("restores the latest controlled ratios on cancellation rather than stale gesture origins", () => {
  const { handle, batch, single, pane, rerender, ratio } = setup();
  pointer(handle, "pointerdown", 502, 402);
  pointer(window, "pointermove", 602, 482);
  act(() => {
    vi.advanceTimersByTime(16);
  });
  rerender(
    <PanelLayout
      layout={{ ...tree, ratio: 0.65 }}
      renderPane={pane}
      onResize={single}
      onResizeMany={batch}
      resizeLabel="Resize"
    />,
  );
  fireEvent.keyDown(window, { key: "Escape" });
  expect(ratio("outer")).toBe(0.65);
  expect(ratio("left")).toBe(0.5);
  expect(ratio("right")).toBe(0.5);
  expect(batch).not.toHaveBeenCalled();
});

it("recomputes T junctions when ratios move separators without changing their own sizes", () => {
  const { batch, single, pane, rerender } = setup();
  if (tree.second.kind !== "split") throw new Error("test layout");
  rerender(
    <PanelLayout
      layout={{ ...tree, second: { ...tree.second, ratio: 0.75 } }}
      renderPane={pane}
      onResize={single}
      onResizeMany={batch}
      resizeLabel="Resize"
    />,
  );
  act(() => {
    vi.advanceTimersByTime(20);
  });
  const handles = screen.getAllByRole("button", { name: "Resize intersecting panels" });
  expect(handles).toHaveLength(2);
  const upper = handles.sort((a, b) => parseFloat(a.style.top) - parseFloat(b.style.top))[0]!;
  pointer(upper, "pointerdown", 502, 402);
  pointer(window, "pointerup", 602, 482);
  expect(batch).toHaveBeenCalledExactlyOnceWith({ outer: 0.6, left: 0.6 });
});

it("keeps equal semantic split IDs isolated across DOM roots in one application scope", () => {
  const first = vi.fn(),
    second = vi.fn();
  const view = render(
    <SplitGeometryScope>
      <section data-testid="first">
        <PanelLayout
          layout={tree}
          renderPane={(id) => <span>{id}</span>}
          onResize={vi.fn()}
          onResizeMany={first}
          resizeLabel="Resize"
        />
      </section>
      <section data-testid="second">
        <PanelLayout
          layout={tree}
          renderPane={(id) => <span>{id}</span>}
          onResize={vi.fn()}
          onResizeMany={second}
          resizeLabel="Resize"
        />
      </section>
    </SplitGeometryScope>,
  );
  const a = mockGeometry(screen.getByTestId("first"));
  const b = mockGeometry(screen.getByTestId("second"));
  act(() => vi.advanceTimersByTime(20));
  expect(screen.getAllByRole("button", { name: "Resize intersecting panels" })).toHaveLength(2);
  const handle = screen.getByTestId("first").querySelector("button")!;
  pointer(handle, "pointerdown", 502, 402);
  pointer(window, "pointerup", 602, 482);
  expect(first).toHaveBeenCalledExactlyOnceWith({ outer: 0.6, left: 0.6, right: 0.6 });
  expect(second).not.toHaveBeenCalled();
  expect(b.ratio("outer")).toBe(0.5);
  expect(a.ratio("outer")).toBe(0.6);
  view.unmount();
});
it("finds nested splits across a retained content portal and cancels when topology changes", () => {
  const batch = vi.fn();
  const target = document.createElement("div");
  const renderPane = (id: string) => <span>{id}</span>;
  // React content is elsewhere in the tree, but the portal is a DOM descendant
  // of the outer split, as retained file preview panes are in the workbench.
  const App = ({ nested = true }: { nested?: boolean }) => (
    <SplitGeometryScope>
      <PanelLayout
        layout={{
          kind: "split",
          id: "outer",
          direction: "row",
          ratio: 0.5,
          first: leaf("a"),
          second: leaf("b"),
        }}
        renderPane={(id) =>
          id === "a" ? (
            <div
              ref={(node) => {
                if (node && !node.contains(target)) node.append(target);
              }}
            />
          ) : (
            renderPane(id)
          )
        }
        onResize={vi.fn()}
        onResizeMany={batch}
        resizeLabel="Resize"
      />
      {nested &&
        createPortal(
          <PanelLayout
            layout={tree.first}
            renderPane={(id) => <span>{id}</span>}
            onResize={vi.fn()}
            onResizeMany={batch}
            resizeLabel="Resize"
          />,
          target,
        )}
    </SplitGeometryScope>
  );
  const view = render(<App />);
  const outer = view.container.querySelector<HTMLElement>('[data-split-id="outer"]')!;
  const left = view.container.querySelector<HTMLElement>('[data-split-id="left"]')!;
  vi.spyOn(outer, "getBoundingClientRect").mockReturnValue(rect(0, 0, 1004, 804));
  vi.spyOn(
    outer.querySelector<HTMLElement>(":scope > [role=separator]")!,
    "getBoundingClientRect",
  ).mockReturnValue(rect(500, 0, 4, 804));
  vi.spyOn(left, "getBoundingClientRect").mockReturnValue(rect(0, 0, 500, 804));
  vi.spyOn(
    left.querySelector<HTMLElement>(":scope > [role=separator]")!,
    "getBoundingClientRect",
  ).mockReturnValue(rect(0, 400, 500, 4));
  act(() => vi.advanceTimersByTime(20));
  const handle = screen.getByRole("button", { name: "Resize intersecting panels" });
  pointer(handle, "pointerdown", 502, 402);
  pointer(window, "pointermove", 602, 482);
  act(() => vi.advanceTimersByTime(16));
  view.rerender(<App nested={false} />);
  pointer(window, "pointerup", 602, 482);
  expect(batch).not.toHaveBeenCalled();
  expect(viewIsBusy()).toBe(false);
  expect(document.body.style.cursor).toBe("");
  expect(outer.style.getPropertyValue("--td-split-ratio")).toBe("0.5");
});
