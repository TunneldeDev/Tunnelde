import { act, fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Resizer } from "@/components/layout/Resizer";

/** jsdom has no PointerEvent, so dispatch mouse events under the pointer names. */
function pointer(type: string, clientX: number, pointerId = 1, button = 0): MouseEvent {
  const event = new MouseEvent(type, { bubbles: true, clientX, button });
  Object.defineProperty(event, "pointerId", { value: pointerId });
  return event;
}

describe("Resizer", () => {
  it("coalesces pointer bursts per frame and flushes the last pixel before committing", () => {
    const request = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(42);
    const cancel = vi.spyOn(window, "cancelAnimationFrame");
    const onChange = vi.fn();
    const onCommit = vi.fn();
    const { getByRole, unmount } = render(
      <Resizer
        value={300}
        min={200}
        max={600}
        edge="right"
        label="Panel"
        onChange={onChange}
        onCommit={onCommit}
      />,
    );
    const handle = getByRole("separator");
    Object.assign(handle, { setPointerCapture: vi.fn(), hasPointerCapture: () => false });
    fireEvent(handle, pointer("pointerdown", 500));
    for (let x = 501; x <= 560; x++) fireEvent(handle, pointer("pointermove", x));
    expect(request).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
    act(() => request.mock.calls[0]![0](0));
    expect(onChange).toHaveBeenCalledExactlyOnceWith(360);
    fireEvent(handle, pointer("pointermove", 580));
    fireEvent(handle, pointer("pointerup", 580));
    expect(cancel).toHaveBeenCalledWith(42);
    expect(onChange).toHaveBeenLastCalledWith(380);
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(380);
    // No pending work may update the parent after unmount.
    fireEvent(handle, pointer("pointerdown", 580));
    fireEvent(handle, pointer("pointermove", 590));
    unmount();
    expect(cancel).toHaveBeenCalledTimes(2);
  });

  it("reports whole pixels and commits the value the drag ended on", () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    const { container } = render(
      <Resizer
        value={272}
        min={220}
        max={420}
        edge="right"
        label="Sidebar width"
        onChange={onChange}
        onCommit={onCommit}
      />,
    );

    const handle = container.querySelector(".td-resizer") as HTMLElement;
    Object.assign(handle, {
      setPointerCapture: vi.fn(),
      releasePointerCapture: vi.fn(),
      hasPointerCapture: vi.fn().mockReturnValue(true),
    });

    fireEvent(handle, pointer("pointerdown", 500));
    fireEvent(handle, pointer("pointermove", 530.6));
    fireEvent(handle, pointer("pointermove", 548.2));
    fireEvent(handle, pointer("pointerup", 548.2));

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith(320);
    expect(onCommit).toHaveBeenCalledWith(320);
    // The commit must not fall back to the width the render started with.
    expect(onCommit).not.toHaveBeenCalledWith(272);
  });

  it("ignores secondary buttons and unrelated pointers during an active drag", () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    const { getByRole } = render(
      <Resizer
        value={300}
        min={220}
        max={420}
        edge="left"
        label="Panel"
        onChange={onChange}
        onCommit={onCommit}
      />,
    );
    const handle = getByRole("separator");
    Object.assign(handle, {
      setPointerCapture: vi.fn(),
      hasPointerCapture: vi.fn().mockReturnValue(true),
      releasePointerCapture: vi.fn(),
    });
    fireEvent(handle, pointer("pointerdown", 500, 1, 2));
    fireEvent(handle, pointer("pointermove", 460));
    expect(onChange).not.toHaveBeenCalled();
    fireEvent(handle, pointer("pointerdown", 500));
    fireEvent(handle, pointer("pointerdown", 800, 2));
    fireEvent(handle, pointer("pointermove", 400, 2));
    fireEvent(handle, pointer("pointerup", 400, 2));
    expect(onChange).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent(handle, pointer("pointermove", 460));
    fireEvent(handle, pointer("pointerup", 460));
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(340);
  });

  it("ends a drag once when pointer capture is lost, without resizing on hover afterwards", () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    const { getByRole } = render(
      <Resizer
        value={300}
        min={220}
        max={420}
        edge="right"
        label="Sidebar"
        onChange={onChange}
        onCommit={onCommit}
      />,
    );
    const handle = getByRole("separator");
    const release = vi.fn();
    Object.assign(handle, {
      setPointerCapture: vi.fn(),
      hasPointerCapture: vi.fn().mockReturnValue(false),
      releasePointerCapture: release,
    });
    fireEvent(handle, pointer("pointerdown", 500));
    fireEvent(handle, pointer("pointermove", 550));
    fireEvent(handle, pointer("lostpointercapture", 550));
    fireEvent(handle, pointer("pointerup", 600));
    fireEvent(handle, pointer("pointermove", 650));
    expect(onChange).toHaveBeenCalledExactlyOnceWith(350);
    expect(onCommit).toHaveBeenCalledExactlyOnceWith(350);
    expect(release).not.toHaveBeenCalled();
  });
});
