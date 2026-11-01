import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Menu } from "@/components/ui/overlay/Menu";

describe("Menu radio choices", () => {
  it("announces the label separately from its description and navigates enabled choices", () => {
    const select = vi.fn();
    render(
      <Menu
        label="Permissions"
        trigger={<>Manual permissions</>}
        items={[
          { label: "Ask", description: "Ask before changes", checked: true, onSelect: vi.fn() },
          {
            label: "Unavailable",
            description: "This choice cannot run",
            checked: false,
            disabled: true,
            onSelect: vi.fn(),
          },
          { label: "Read only", description: "Bounded reads", checked: false, onSelect: select },
        ]}
      />,
    );
    const trigger = screen.getByRole("button", { name: "Permissions" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const first = screen.getByRole("menuitemradio", { name: "Ask" });
    expect(first.getAttribute("aria-checked")).toBe("true");
    expect(document.getElementById(first.getAttribute("aria-describedby")!)?.textContent).toBe(
      "Ask before changes",
    );
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "ArrowDown" });
    const last = screen.getByRole("menuitemradio", { name: "Read only" });
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(last, { key: "Enter" });
    expect(select).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("closes an open popup if its trigger becomes disabled", () => {
    const props = {
      label: "Model",
      trigger: <>Model name</>,
      items: [{ label: "One", checked: true, onSelect: vi.fn() }],
    };
    const view = render(<Menu {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    expect(screen.getByRole("menu")).toBeTruthy();
    view.rerender(<Menu {...props} disabled />);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
