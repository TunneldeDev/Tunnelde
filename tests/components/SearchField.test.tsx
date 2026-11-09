import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import "@/i18n/i18n";
import { SearchField } from "@/components/ui/form/SearchField";

function Fixture({ disabled = false }: { disabled?: boolean }) {
  const [value, setValue] = useState('hello "@tag:literal"');
  return (
    <SearchField
      aria-label="Search fixture"
      value={value}
      onChange={setValue}
      disabled={disabled}
      filterKeys={["tag", "id"]}
      presets={[
        { key: "tag", value: "a,b", label: "Comma tag" },
        { key: "id", value: "", label: "By ID" },
      ]}
    />
  );
}

describe("shared search field", () => {
  it("edits visible qualifiers from the funnel, keeps literal text and restores input focus", async () => {
    render(<Fixture />);
    const input = screen.getByRole("textbox", { name: "Search fixture" }) as HTMLInputElement;
    fireEvent.click(screen.getByRole("button", { name: "Filter presets" }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /Comma tag/ }));
    expect(input.value).toBe('hello "@tag:literal" @tag:"a,b"');
    await waitFor(() => expect(document.activeElement).toBe(input));
    fireEvent.click(screen.getByRole("button", { name: "Filter presets" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Clear filters, keep search text" }));
    expect(input.value).toBe('hello "@tag:literal"');
  });

  it("inserts an editable prefix as an ordinary menu item and clears the whole query", () => {
    render(<Fixture />);
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.click(screen.getByRole("button", { name: "Filter presets" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /By ID/ }));
    expect(input.value).toBe('hello "@tag:literal" @id:');
    fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
    expect(input.value).toBe("");
  });

  it("disables presets and clear actions along with the input", () => {
    render(<Fixture disabled />);
    expect((screen.getByRole("textbox") as HTMLInputElement).disabled).toBe(true);
    for (const button of screen.getAllByRole("button"))
      expect((button as HTMLButtonElement).disabled).toBe(true);
  });
});
