// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ContextMenuHost } from "@/components/ui/ContextMenu";
import { useContextMenu } from "@/store/contextMenu";

beforeEach(() => {
  useContextMenu.setState({ menu: null });
});

describe("ContextMenuHost", () => {
  it("renders items and reports the selection", () => {
    const onDelete = vi.fn();
    useContextMenu.getState().open(40, 60, [
      { label: "Rename", onSelect: () => undefined },
      { label: "Delete", danger: true, onSelect: onDelete },
    ]);

    render(<ContextMenuHost />);
    expect(screen.getByRole("menu")).toBeTruthy();

    fireEvent.click(screen.getByText("Delete"));
    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(useContextMenu.getState().menu).toBeNull();
  });

  it("closes on escape", () => {
    useContextMenu.getState().open(10, 10, [{ label: "Open", onSelect: () => undefined }]);
    render(<ContextMenuHost />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useContextMenu.getState().menu).toBeNull();
  });
});
