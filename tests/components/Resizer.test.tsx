// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Resizer } from "@/components/layout/Resizer";

/** jsdom has no PointerEvent, so dispatch mouse events under the pointer names. */
function pointer(type: string, clientX: number, pointerId = 1, button = 0): MouseEvent {
  const event = new MouseEvent(type, { bubbles: true, clientX, button });
  Object.defineProperty(event, "pointerId", { value: pointerId });
  return event;
}

describe("Resizer", () => {
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

    expect(onChange).toHaveBeenNthCalledWith(1, 303);
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
