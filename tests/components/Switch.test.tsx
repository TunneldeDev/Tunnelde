import { fireEvent, render, screen } from "@testing-library/react";
import { createRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Switch as LegacySwitch } from "@/components/ui/form/Field";
import { Switch, SwitchRow } from "@/components/ui/form/Switch";

describe("shared switch", () => {
  it("preserves existing imports and reports controlled changes without submitting forms", () => {
    expect(LegacySwitch).toBe(Switch);
    const submit = vi.fn();
    function Fixture() {
      const [checked, setChecked] = useState(false);
      return (
        <form onSubmit={submit}>
          <Switch checked={checked} onChange={setChecked} label="Retry" />
        </form>
      );
    }
    render(<Fixture />);
    const control = screen.getByRole("switch", { name: "Retry" });
    expect(control.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(control);
    expect(control.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(control);
    expect(control.getAttribute("aria-checked")).toBe("false");
    expect(submit).not.toHaveBeenCalled();
  });

  it("forwards customization, focus and native disabled semantics", () => {
    const change = vi.fn();
    const ref = createRef<HTMLButtonElement>();
    render(
      <Switch
        checked
        onChange={change}
        label="Disabled"
        disabled
        ref={ref}
        id="custom"
        className="custom-switch"
        style={{ opacity: 0.5 }}
        title="Unavailable"
      />,
    );
    const control = screen.getByRole("switch", { name: "Disabled" }) as HTMLButtonElement;
    expect(ref.current).toBe(control);
    expect(control.id).toBe("custom");
    expect(control.classList.contains("custom-switch")).toBe(true);
    expect(control.style.opacity).toBe("0.5");
    expect(control.disabled).toBe(true);
    fireEvent.click(control);
    expect(change).not.toHaveBeenCalled();
  });

  it("links each row's label and description without replacing external descriptions", () => {
    const change = vi.fn();
    render(
      <>
        <p id="extra">External context</p>
        <SwitchRow
          checked={false}
          onChange={change}
          label="Retry"
          hint="Retry after connection failure"
          descriptionId="extra"
        />
        <SwitchRow checked onChange={change} label="Auto start" hint="Start on launch" />
      </>,
    );
    const retry = screen.getByRole("switch", { name: "Retry" });
    const autoStart = screen.getByRole("switch", { name: "Auto start" });
    expect(retry.id).not.toBe(autoStart.id);
    expect(screen.getByLabelText("Retry")).toBe(retry);
    const descriptions = retry.getAttribute("aria-describedby")!.split(" ");
    expect(descriptions[0]).toBe("extra");
    expect(document.getElementById(descriptions[1]!)?.textContent).toBe(
      "Retry after connection failure",
    );
    fireEvent.click(screen.getByText("Retry", { selector: "label" }));
    expect(change).toHaveBeenCalledWith(true);
  });

  it("does not create an empty description when no hint is provided", () => {
    render(<SwitchRow checked={false} onChange={() => {}} label="Retry" />);
    expect(screen.getByRole("switch").hasAttribute("aria-describedby")).toBe(false);
  });
});
