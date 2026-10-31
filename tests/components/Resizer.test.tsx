// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Resizer } from "@/components/layout/Resizer";

/** jsdom has no PointerEvent, so dispatch mouse events under the pointer names. */
function pointer(type: string, clientX: number): MouseEvent {
  return new MouseEvent(type, { bubbles: true, clientX, pointerId: 1 } as MouseEventInit);
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
});
