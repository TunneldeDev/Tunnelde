import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { PanelLayout } from "@/components/ui/layout/PanelLayout";
import { SplitPanels } from "@/components/ui/layout/SplitPanels";
import type { PanelLayoutNode } from "@/lib/layout/types";

function StatefulPane({ id }: { id: string }) {
  const [value, setValue] = useState("");
  return <input aria-label={id} value={value} onChange={(event) => setValue(event.target.value)} />;
}

describe("controlled panel layout", () => {
  it("renders nested arbitrary panes and reports a targeted resize without owning persistence", () => {
    const layout: PanelLayoutNode = {
      kind: "split",
      id: "outer",
      direction: "row",
      ratio: 0.4,
      first: { kind: "pane", paneId: "left" },
      second: {
        kind: "split",
        id: "inner",
        direction: "column",
        ratio: 0.6,
        first: { kind: "pane", paneId: "top" },
        second: { kind: "pane", paneId: "bottom" },
      },
    };
    const onResize = vi.fn();
    const renderPane = (id: string) => <StatefulPane id={id} />;
    const view = render(
      <PanelLayout
        layout={layout}
        renderPane={renderPane}
        onResize={onResize}
        resizeLabel="Resize"
      />,
    );
    const top = screen.getByRole("textbox", { name: "top" });
    fireEvent.change(top, { target: { value: "preserve" } });
    const separators = screen.getAllByRole("separator");
    expect(separators.map((node) => node.getAttribute("aria-orientation"))).toEqual([
      "vertical",
      "horizontal",
    ]);
    fireEvent.keyDown(separators[1]!, { key: "ArrowDown" });
    expect(onResize).toHaveBeenCalledExactlyOnceWith("inner", 0.65);
    expect(layout.second.kind === "split" && layout.second.ratio).toBe(0.6);
    view.rerender(
      <PanelLayout
        layout={{ ...layout, ratio: 0.7 }}
        renderPane={renderPane}
        onResize={onResize}
        resizeLabel="Resize"
      />,
    );
    expect(screen.getByRole("textbox", { name: "top" })).toBe(top);
    expect((top as HTMLInputElement).value).toBe("preserve");
  });

  it("supports vertical grid consumers, accessibility bounds, IME and controlled updates", () => {
    const change = vi.fn();
    render(
      <SplitPanels
        mode="grid"
        direction="column"
        ratio={0.6}
        minRatio={0.2}
        maxRatio={0.8}
        label="Preview size"
        first={<div>Preview</div>}
        second={<div>Details</div>}
        onRatioChange={change}
      />,
    );
    const separator = screen.getByRole("separator");
    expect(separator.getAttribute("aria-orientation")).toBe("horizontal");
    fireEvent.keyDown(separator, { key: "ArrowRight" });
    fireEvent.keyDown(separator, { key: "ArrowDown", isComposing: true });
    expect(change).not.toHaveBeenCalled();
    fireEvent.keyDown(separator, { key: "Home" });
    fireEvent.keyDown(separator, { key: "End" });
    fireEvent.doubleClick(separator);
    expect(change.mock.calls).toEqual([[0.2], [0.8], [0.5]]);
    expect(separator.getAttribute("aria-valuenow")).toBe("60");
  });

  it("does not send duplicate commit callbacks for stationary splitter clicks", () => {
    const change = vi.fn();
    render(
      <SplitPanels ratio={0.5} label="Resize" first={null} second={null} onRatioChange={change} />,
    );
    const separator = screen.getByRole("separator");
    vi.spyOn(separator.parentElement!, "getBoundingClientRect").mockReturnValue({
      width: 1000,
      height: 600,
    } as DOMRect);
    const pointer = (target: Element | Window, type: string) => {
      const event = new MouseEvent(type, { bubbles: true, button: 0, clientX: 500 });
      Object.defineProperty(event, "pointerId", { value: 1 });
      fireEvent(target, event);
    };
    act(() => {
      pointer(separator, "pointerdown");
      pointer(window, "pointerup");
    });
    expect(change).not.toHaveBeenCalled();
  });
});
