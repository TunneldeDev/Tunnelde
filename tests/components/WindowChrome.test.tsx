// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { win } = vi.hoisted(() => ({
  win: {
    minimize: vi.fn(),
    toggleMaximize: vi.fn(),
    close: vi.fn(),
    isMaximized: vi.fn(),
    onResized: vi.fn(),
    startResizeDragging: vi.fn(),
  },
}));

vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => win }));
vi.mock("@/lib/api/ipc", () => ({ isTauri: () => true }));

import "@/i18n/i18n";
import { WindowChrome } from "@/components/layout/WindowChrome";

beforeEach(() => {
  win.minimize.mockReset();
  win.toggleMaximize.mockReset();
  win.close.mockReset();
  win.startResizeDragging.mockReset();
  win.isMaximized.mockReset().mockResolvedValue(false);
  win.onResized.mockReset().mockResolvedValue(() => undefined);
});

describe("WindowChrome", () => {
  it("drives the window buttons", async () => {
    render(<WindowChrome />);

    fireEvent.click(screen.getByRole("button", { name: "Minimize" }));
    fireEvent.click(screen.getByRole("button", { name: "Maximize" }));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(win.minimize).toHaveBeenCalled();
    expect(win.toggleMaximize).toHaveBeenCalled();
    expect(win.close).toHaveBeenCalled();
  });

  it("starts a resize drag from an edge grip", () => {
    const { container } = render(<WindowChrome />);
    const east = container.querySelector(".window-grip.is-east") as HTMLElement;

    fireEvent.mouseDown(east);

    expect(win.startResizeDragging).toHaveBeenCalledWith("East");
  });

  it("switches the maximize button when the window is maximized", async () => {
    win.isMaximized.mockResolvedValue(true);
    render(<WindowChrome />);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Restore" })).toBeTruthy();
    });
  });
});
