import { act, fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { usePointerDrag } from "@/lib/session/usePointerDrag";

function pointer(type: string, clientX: number, pointerId = 1, button = 0) {
  const event = new MouseEvent(type, {
    bubbles: true,
    clientX,
    button,
    buttons: type === "pointermove" ? 1 : 0,
  });
  Object.defineProperty(event, "pointerId", { value: pointerId });
  return event;
}

function setup() {
  const move = vi.fn();
  const commit = vi.fn();
  const cancel = vi.fn();
  function Handle() {
    const begin = usePointerDrag();
    return (
      <div role="separator" onPointerDown={(event) => begin(event, { move, commit, cancel })} />
    );
  }
  const view = render(<Handle />);
  const handle = view.getByRole("separator");
  const capture = vi.fn();
  const release = vi.fn();
  Object.assign(handle, {
    setPointerCapture: capture,
    hasPointerCapture: () => true,
    releasePointerCapture: release,
  });
  return { ...view, handle, move, commit, cancel, capture, release };
}

describe("pointer drag lifecycle", () => {
  it("coalesces motion and commits the final release coordinates once", () => {
    const frame = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(42);
    const cancelFrame = vi.spyOn(window, "cancelAnimationFrame");
    const view = setup();
    fireEvent(view.handle, pointer("pointerdown", 100));
    for (let x = 101; x <= 150; x++) fireEvent(window, pointer("pointermove", x));
    expect(frame).toHaveBeenCalledTimes(1);
    expect(view.move).not.toHaveBeenCalled();
    act(() => frame.mock.calls[0]![0](0));
    expect(view.move).toHaveBeenCalledTimes(1);
    expect(view.move.mock.calls[0]![0].clientX).toBe(150);
    fireEvent(window, pointer("pointermove", 160));
    fireEvent(window, pointer("pointerup", 180));
    expect(cancelFrame).toHaveBeenCalledWith(42);
    expect(view.move.mock.lastCall![0].clientX).toBe(180);
    expect(view.commit).toHaveBeenCalledOnce();
    expect(view.release).toHaveBeenCalledExactlyOnceWith(1);
    fireEvent(view.handle, pointer("lostpointercapture", 180));
    fireEvent(window, pointer("pointerup", 200));
    expect(view.commit).toHaveBeenCalledOnce();
    expect(view.cancel).not.toHaveBeenCalled();
  });

  it("ignores secondary buttons and every event belonging to another pointer", () => {
    const view = setup();
    fireEvent(view.handle, pointer("pointerdown", 100, 1, 2));
    expect(view.capture).not.toHaveBeenCalled();
    fireEvent(view.handle, pointer("pointerdown", 100));
    fireEvent(view.handle, pointer("pointerdown", 400, 2));
    fireEvent(window, pointer("pointermove", 500, 2));
    fireEvent(window, pointer("pointerup", 500, 2));
    fireEvent(window, pointer("pointercancel", 500, 2));
    fireEvent(view.handle, pointer("lostpointercapture", 500, 2));
    expect(view.move).not.toHaveBeenCalled();
    expect(view.commit).not.toHaveBeenCalled();
    expect(view.cancel).not.toHaveBeenCalled();
    fireEvent(window, pointer("pointerup", 150));
    expect(view.move.mock.lastCall![0].clientX).toBe(150);
    expect(view.commit).toHaveBeenCalledOnce();
  });

  it.each(["pointercancel", "lostpointercapture", "blur", "Escape", "unmount"])(
    "discards previews and removes pending work on %s",
    (reason) => {
      const frame = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(42);
      const cancelFrame = vi.spyOn(window, "cancelAnimationFrame");
      const view = setup();
      fireEvent(view.handle, pointer("pointerdown", 100));
      fireEvent(window, pointer("pointermove", 150));
      expect(frame).toHaveBeenCalledOnce();
      if (reason === "unmount") view.unmount();
      else if (reason === "blur") fireEvent(window, new Event("blur"));
      else if (reason === "Escape") fireEvent.keyDown(window, { key: "Escape" });
      else fireEvent(view.handle, pointer(reason, 150));
      expect(cancelFrame).toHaveBeenCalledWith(42);
      expect(view.cancel).toHaveBeenCalledOnce();
      fireEvent(window, pointer("pointermove", 180));
      fireEvent(window, pointer("pointerup", 200));
      expect(view.move).not.toHaveBeenCalled();
      expect(view.commit).not.toHaveBeenCalled();
    },
  );

  it("still completes outside the handle if pointer capture is unavailable", () => {
    const view = setup();
    view.capture.mockImplementation(() => {
      throw new Error("No active pointer");
    });
    fireEvent(view.handle, pointer("pointerdown", 100));
    fireEvent(window, pointer("pointerup", 180));
    expect(view.commit).toHaveBeenCalledOnce();
    expect(view.move.mock.lastCall![0].clientX).toBe(180);
  });

  it("cancels when motion reports that the primary button was already released", () => {
    const view = setup();
    fireEvent(view.handle, pointer("pointerdown", 100));
    const hover = new MouseEvent("pointermove", { bubbles: true, clientX: 150, buttons: 0 });
    Object.defineProperty(hover, "pointerId", { value: 1 });
    fireEvent(window, hover);
    fireEvent(window, pointer("pointerup", 150));
    expect(view.cancel).toHaveBeenCalledOnce();
    expect(view.commit).not.toHaveBeenCalled();
    expect(view.move).not.toHaveBeenCalled();
  });
});
