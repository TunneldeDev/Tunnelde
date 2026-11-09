import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DataColumnHeader } from "@/components/ui/display/DataColumnHeader";

const props = () => ({
  id: "address",
  label: "Address",
  width: 180,
  scope: "hosts",
  onSort: vi.fn(),
  onResize: vi.fn(),
  onMove: vi.fn(),
  resizeLabel: "Resize Address",
  moveHint: "Drag to reorder",
});
function pointer(target: HTMLElement, type: string, x: number, id = 1) {
  const event = new MouseEvent(type, { bubbles: true, clientX: x, button: 0 });
  Object.defineProperty(event, "pointerId", { value: id });
  fireEvent(target, event);
}
describe("shared data column interactions", () => {
  it("previews without committing and restores the original width on cancel or lost capture", () => {
    const p = props();
    render(<DataColumnHeader {...p} />);
    const handle = screen.getByRole("separator");
    handle.setPointerCapture = vi.fn();
    handle.releasePointerCapture = vi.fn();
    pointer(handle, "pointerdown", 100);
    pointer(handle, "pointermove", 160, 2);
    expect(p.onResize).not.toHaveBeenCalled();
    pointer(handle, "pointermove", 160);
    expect(p.onResize).toHaveBeenLastCalledWith(240, false);
    pointer(handle, "pointercancel", 160);
    expect(p.onResize).toHaveBeenLastCalledWith(180, false);
    pointer(handle, "pointerup", 160);
    expect(p.onResize).not.toHaveBeenCalledWith(240, true);
    pointer(handle, "pointerdown", 100);
    pointer(handle, "pointermove", 900);
    pointer(handle, "pointerup", 900);
    expect(p.onResize).toHaveBeenLastCalledWith(480, true);
    pointer(handle, "pointerdown", 100);
    pointer(handle, "pointermove", 40);
    pointer(handle, "lostpointercapture", 40);
    expect(p.onResize).toHaveBeenLastCalledWith(180, false);
    pointer(handle, "pointerdown", 100);
    pointer(handle, "pointermove", 40);
    fireEvent.keyDown(handle, { key: "Escape" });
    expect(p.onResize).toHaveBeenLastCalledWith(180, false);
  });
  it("supports keyboard resize, sort and scoped reordering without treating file drops as columns", () => {
    const p = props();
    render(
      <div>
        <DataColumnHeader {...p} />
        <DataColumnHeader {...p} id="user" label="User" resizeLabel="Resize User" />
      </div>,
    );
    fireEvent.keyDown(screen.getByRole("separator", { name: "Resize Address" }), {
      key: "ArrowRight",
    });
    expect(p.onResize).toHaveBeenLastCalledWith(190, true);
    fireEvent.click(screen.getByRole("button", { name: "Address" }));
    expect(p.onSort).toHaveBeenCalledOnce();
    fireEvent.keyDown(screen.getByRole("button", { name: "Address" }), {
      key: "ArrowRight",
      altKey: true,
    });
    expect(p.onMove).toHaveBeenLastCalledWith("address", "user");
    p.onMove.mockClear();
    const target = screen.getAllByRole("columnheader")[0]!;
    const drop = (scope: string, types = ["application/x-tunnelde-data-column"]) =>
      fireEvent.drop(target, {
        dataTransfer: { types, getData: () => JSON.stringify({ scope, id: "user" }) },
      });
    drop("files");
    drop("hosts", ["Files"]);
    expect(p.onMove).not.toHaveBeenCalled();
    drop("hosts");
    expect(p.onMove).toHaveBeenCalledExactlyOnceWith("user", "address");
  });
});
