import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ContextMenuHost } from "@/components/ui/overlay/ContextMenu";
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

  it("groups actions without changing their indices and skips separators and disabled entries", () => {
    const onSelect = vi.fn();
    useContextMenu.getState().open(10, 10, [
      { label: "Open", separatorBefore: true, onSelect: vi.fn() },
      { label: "Unavailable", disabled: true, onSelect: vi.fn() },
      { label: "Edit", separatorBefore: true, onSelect: vi.fn() },
      { label: "Delete", separatorBefore: true, onSelect },
    ]);
    render(<ContextMenuHost />);
    const items = screen.getAllByRole("menuitem");
    expect(screen.getAllByRole("separator")).toHaveLength(2);
    expect(items).toHaveLength(4);
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0]!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[2]);
    fireEvent.keyDown(items[2]!, { key: "End" });
    expect(document.activeElement).toBe(items[3]);
    fireEvent.keyDown(items[3]!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0]!, { key: "ArrowUp" });
    expect(document.activeElement).toBe(items[3]);
    fireEvent.keyDown(items[3]!, { key: "Home" });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(items[0]!, { key: "End" });
    fireEvent.keyDown(items[3]!, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledExactlyOnceWith();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("restores the trigger on Escape and lets an action focus its dialog", () => {
    const trigger = document.createElement("button");
    const field = document.createElement("input");
    document.body.append(trigger, field);
    trigger.focus();
    act(() =>
      useContextMenu.getState().open(10, 10, [{ label: "Edit", onSelect: () => field.focus() }]),
    );
    const { unmount } = render(<ContextMenuHost />);
    fireEvent.keyDown(screen.getByRole("menuitem"), { key: "Escape" });
    expect(document.activeElement).toBe(trigger);
    act(() =>
      useContextMenu.getState().open(10, 10, [{ label: "Edit", onSelect: () => field.focus() }]),
    );
    fireEvent.click(screen.getByRole("menuitem"));
    expect(document.activeElement).toBe(field);
    unmount();
    trigger.remove();
    field.remove();
  });

  it("clamps the measured grouped menu inside the viewport", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 210,
      bottom: 300,
      width: 210,
      height: 300,
      toJSON: () => ({}),
    });
    useContextMenu.getState().open(window.innerWidth - 5, window.innerHeight - 4, [
      { label: "Open", onSelect: vi.fn() },
      { label: "Delete", separatorBefore: true, onSelect: vi.fn() },
    ]);
    render(<ContextMenuHost />);
    const menu = screen.getByRole("menu");
    expect(menu.style.left).toBe(`${window.innerWidth - 210 - 8}px`);
    expect(menu.style.top).toBe(`${window.innerHeight - 300 - 8}px`);
  });
});
