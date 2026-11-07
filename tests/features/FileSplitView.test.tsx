import { act, fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import "@/i18n/i18n";
import { FileSplitView } from "@/features/sftp/FileSplitView";

function pointer(type: string, clientX: number, pointerId = 1) {
  const event = new MouseEvent(type, {
    bubbles: true,
    clientX,
    button: 0,
    buttons: type === "pointermove" ? 1 : 0,
  });
  Object.defineProperty(event, "pointerId", { value: pointerId });
  return event;
}

function setup() {
  localStorage.clear();
  const view = render(
    <FileSplitView storageKey="qa-split" left={<div>Local</div>} right={<div>Remote</div>} />,
  );
  const panel = view.container.firstElementChild as HTMLElement;
  const handle = view.getByRole("separator");
  vi.spyOn(panel, "getBoundingClientRect").mockReturnValue({ left: 100, width: 1000 } as DOMRect);
  return { ...view, panel, handle };
}

describe("file split resizing", () => {
  it("previews once per frame without storing and saves the actual release position", () => {
    const frame = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(42);
    const view = setup();
    const store = vi.spyOn(Storage.prototype, "setItem");
    fireEvent(view.handle, pointer("pointerdown", 600));
    for (let x = 610; x <= 800; x += 10) fireEvent(window, pointer("pointermove", x));
    expect(frame).toHaveBeenCalledOnce();
    expect(view.handle.getAttribute("aria-valuenow")).toBe("50");
    act(() => frame.mock.calls[0]![0](0));
    expect(view.handle.getAttribute("aria-valuenow")).toBe("70");
    expect(view.panel.style.gridTemplateColumns).toContain("70fr");
    expect(store).not.toHaveBeenCalled();
    fireEvent(window, pointer("pointerup", 850));
    expect(view.panel.style.gridTemplateColumns).toBe("minmax(0, 75fr) 6px minmax(0, 25fr)");
    expect(store).toHaveBeenCalledExactlyOnceWith("qa-split", "75");
  });

  it.each(["pointercancel", "Escape", "blur"])("restores the original split on %s", (reason) => {
    const frame = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(42);
    const view = setup();
    fireEvent(view.handle, pointer("pointerdown", 600));
    fireEvent(window, pointer("pointermove", 800));
    act(() => frame.mock.calls[0]![0](0));
    expect(view.handle.getAttribute("aria-valuenow")).toBe("70");
    if (reason === "Escape") fireEvent.keyDown(window, { key: "Escape" });
    else if (reason === "blur") fireEvent(window, new Event("blur"));
    else fireEvent(window, pointer(reason, 800));
    expect(view.handle.getAttribute("aria-valuenow")).toBe("50");
    expect(view.panel.style.gridTemplateColumns).toContain("50fr");
    expect(localStorage.getItem("qa-split")).toBeNull();
    fireEvent(window, pointer("pointerup", 850));
    expect(localStorage.getItem("qa-split")).toBeNull();
  });

  it("keeps keyboard controls, bounds, double-click reset and reload persistence", () => {
    const view = setup();
    fireEvent(view.handle, pointer("pointerdown", 600));
    fireEvent(window, pointer("pointerup", 2000));
    expect(view.handle.getAttribute("aria-valuenow")).toBe("80");
    view.unmount();
    const reopened = render(<FileSplitView storageKey="qa-split" left={null} right={null} />);
    const handle = reopened.getByRole("separator");
    expect(handle.getAttribute("aria-valuenow")).toBe("80");
    fireEvent.keyDown(handle, { key: "Home" });
    expect(handle.getAttribute("aria-valuenow")).toBe("20");
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(handle.getAttribute("aria-valuenow")).toBe("25");
    fireEvent.doubleClick(handle);
    expect(handle.getAttribute("aria-valuenow")).toBe("50");
    expect(localStorage.getItem("qa-split")).toBe("50");
  });

  it("retains a committed keyboard adjustment when an ongoing pointer preview is cancelled", () => {
    const frame = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(42);
    const view = setup();
    fireEvent(view.handle, pointer("pointerdown", 600));
    fireEvent(window, pointer("pointermove", 800));
    act(() => frame.mock.calls[0]![0](0));
    fireEvent.keyDown(view.handle, { key: "ArrowRight" });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(view.handle.getAttribute("aria-valuenow")).toBe("55");
    expect(view.panel.style.gridTemplateColumns).toBe("minmax(0, 55fr) 6px minmax(0, 45fr)");
    expect(localStorage.getItem("qa-split")).toBe("55");
  });
});
