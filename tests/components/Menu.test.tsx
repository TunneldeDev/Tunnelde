import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { Menu } from "@/components/ui/overlay/Menu";

describe("Menu", () => {
  it("renders action groups and navigates enabled items with wrapping, Home and End", () => {
    const selected = vi.fn();
    render(
      <Menu
        label="More"
        items={[
          { label: "Open", separatorBefore: true, onSelect: vi.fn() },
          { label: "Disabled", disabled: true, onSelect: vi.fn() },
          { label: "Edit", separatorBefore: true, onSelect: vi.fn() },
          { label: "Delete", separatorBefore: true, danger: true, onSelect: selected },
        ]}
      />,
    );
    const trigger = screen.getByRole("button", { name: "More" });
    fireEvent.click(trigger);
    const items = screen.getAllByRole("menuitem");
    expect(screen.getAllByRole("separator")).toHaveLength(2);
    expect(items).toHaveLength(4);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
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
    expect(selected).toHaveBeenCalledExactlyOnceWith();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("opens from ArrowUp, restores Escape focus and does not steal a dialog's focus", () => {
    render(
      <>
        <input aria-label="Dialog field" />
        <Menu
          label="More"
          items={[
            { label: "Open", onSelect: vi.fn() },
            {
              label: "Edit",
              separatorBefore: true,
              onSelect: () => screen.getByRole("textbox").focus(),
            },
          ]}
        />
      </>,
    );
    const trigger = screen.getByRole("button", { name: "More" });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowUp" });
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Edit" }));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
    expect(document.activeElement).toBe(screen.getByRole("textbox"));
  });

  it("measures the actual menu height including separators before placing above its trigger", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      const isMenu = this.classList.contains("td-menu");
      const width = isMenu ? 220 : 20;
      const height = isMenu ? 216 : 30;
      const top = isMenu ? 0 : window.innerHeight - 50;
      const right = isMenu ? 220 : window.innerWidth - 2;
      return {
        x: right - width,
        y: top,
        top,
        left: right - width,
        right,
        bottom: top + height,
        width,
        height,
        toJSON: () => ({}),
      };
    });
    render(
      <Menu
        label="More"
        items={[
          { label: "Open", onSelect: vi.fn() },
          { label: "Delete", separatorBefore: true, onSelect: vi.fn() },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    const menu = screen.getByRole("menu");
    expect(menu.style.top).toBe(`${window.innerHeight - 50 - 216 - 4}px`);
    expect(menu.style.left).toBe(`${window.innerWidth - 220 - 8}px`);
  });

  it("dismisses outside without restoring focus over the clicked control", () => {
    render(
      <>
        <input aria-label="Outside" />
        <Menu label="More" items={[{ label: "Open", onSelect: vi.fn() }]} />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    const outside = screen.getByRole("textbox");
    outside.focus();
    fireEvent.pointerDown(outside);
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(outside);
  });

  it("allows an entirely disabled menu to close with the keyboard", () => {
    render(
      <Menu label="More" items={[{ label: "Unavailable", disabled: true, onSelect: vi.fn() }]} />,
    );
    const trigger = screen.getByRole("button", { name: "More" });
    fireEvent.click(trigger);
    expect(document.activeElement).toBe(screen.getByRole("menu"));
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("closes on Tab with the trigger as the next natural focus origin", () => {
    render(<Menu label="More" items={[{ label: "Open", onSelect: vi.fn() }]} />);
    const trigger = screen.getByRole("button", { name: "More" });
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole("menuitem"), { key: "Tab" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
