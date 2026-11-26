import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NumericChoice } from "@/features/settings/components/NumericChoice";
import i18n from "@/i18n/i18n";

it("converts speed units without changing the persisted speed on unit selection", async () => {
  await i18n.changeLanguage("en-US");
  const changed = vi.fn();
  function Control() {
    const [value, setValue] = useState(1024);
    return (
      <NumericChoice
        stateKey="speed"
        label="Speed"
        value={value}
        min={0}
        max={1048576}
        units={[
          { label: "KiB/s", factor: 1 },
          { label: "MiB/s", factor: 1024 },
        ]}
        onChange={(next) => {
          changed(next);
          setValue(next);
        }}
      />
    );
  }
  render(<Control />);
  fireEvent.click(screen.getByRole("button", { name: "Unit for Speed" }));
  fireEvent.click(screen.getByRole("option", { name: "MiB/s" }));
  expect(changed).not.toHaveBeenCalled();
  expect((screen.getByRole("spinbutton") as HTMLInputElement).value).toBe("1");
  fireEvent.change(screen.getByRole("spinbutton"), { target: { value: "1.5" } });
  fireEvent.blur(screen.getByRole("spinbutton"));
  expect(changed).toHaveBeenLastCalledWith(1536);
});

describe("custom transfer choices", () => {
  it("opens an input for a non-preset value and rejects an out-of-range edit", () => {
    const changed = vi.fn();
    render(
      <NumericChoice
        stateKey="workers"
        label="Workers"
        value={3}
        min={1}
        max={8}
        options={[
          { value: "0", label: "Automatic" },
          { value: "4", label: "4" },
        ]}
        onChange={changed}
      />,
    );
    const input = screen.getByRole("spinbutton");
    expect((input as HTMLInputElement).value).toBe("3");
    fireEvent.change(input, { target: { value: "9" } });
    fireEvent.blur(input);
    expect(changed).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toBeTruthy();
    fireEvent.change(input, { target: { value: "5" } });
    fireEvent.blur(input);
    expect(changed).toHaveBeenCalledWith(5);
  });
});
