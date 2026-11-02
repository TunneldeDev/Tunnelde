import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n/i18n";
import { KeyboardShortcuts } from "@/features/settings/KeyboardShortcuts";
import { SHORTCUT_COMMANDS } from "@/lib/keyboard/registry";
import { DEFAULT_SETTINGS } from "@/lib/prefs/defaults";
import { useSettings } from "@/store/settings";
import { useDialogs } from "@/store/dialogs";

beforeEach(() => {
  useSettings.setState({
    settings: { ...DEFAULT_SETTINGS },
    saving: false,
    update: vi.fn(async (patch) => {
      useSettings.setState((state) => ({ settings: { ...state.settings, ...patch } }));
      return true;
    }),
  });
  useDialogs.getState().close();
});
const search = (value: string) =>
  fireEvent.change(screen.getByRole("textbox", { name: "Search commands or shortcuts" }), {
    target: { value },
  });

describe("KeyboardShortcuts", () => {
  it("provides translated command labels in both shipped languages", () => {
    for (const lng of ["en-US", "zh-CN"])
      for (const command of SHORTCUT_COMMANDS)
        expect(i18n.exists(command.label, { lng }), `${lng}:${command.label}`).toBe(true);
  });
  it("records and saves a binding, disables it, and restores its defaults", async () => {
    render(<KeyboardShortcuts />);
    search("page.settings");
    fireEvent.click(screen.getByRole("button", { name: "Edit: Settings Ctrl+," }));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Press a shortcut" }), {
      key: "Y",
      ctrlKey: true,
      shiftKey: true,
    });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save" })));
    expect(useSettings.getState().settings.keyboardShortcuts["page.settings"]).toEqual([
      "Mod+Shift+Y",
    ]);
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Delete: Settings Ctrl+Shift+Y" })),
    );
    expect(useSettings.getState().settings.keyboardShortcuts["page.settings"]).toEqual([]);
    expect(screen.getByText("Unassigned")).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Reset: Settings" })));
    expect(useSettings.getState().settings.keyboardShortcuts).toEqual({});
    expect(screen.getByText("Ctrl+,")).toBeTruthy();
  });
  it("prevents conflicting bindings and preserves the previous shortcut on cancel", () => {
    render(<KeyboardShortcuts />);
    search("page.settings");
    fireEvent.click(screen.getByRole("button", { name: "Edit: Settings Ctrl+," }));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Press a shortcut" }), {
      key: "k",
      ctrlKey: true,
    });
    expect(screen.getByRole("alert").textContent).toContain("Command palette");
    expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Press a shortcut" }), { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: "Press a shortcut" })).toBeNull();
    expect(useSettings.getState().settings.keyboardShortcuts).toEqual({});
  });
  it("records a modified Tab while ordinary Tab remains available for focus navigation", () => {
    render(<KeyboardShortcuts />);
    search("tab.next");
    fireEvent.click(screen.getByRole("button", { name: "Edit: Next tab Ctrl+Tab" }));
    const recorder = screen.getByRole("textbox", { name: "Press a shortcut" });
    expect(fireEvent.keyDown(recorder, { key: "Tab" })).toBe(true);
    expect(fireEvent.keyDown(recorder, { key: "Tab", ctrlKey: true })).toBe(false);
    expect((recorder as HTMLInputElement).value).toBe("Ctrl+Tab");
  });
  it("searches by context and key and resets all after confirmation", async () => {
    useSettings.setState({
      settings: { ...DEFAULT_SETTINGS, keyboardShortcuts: { "page.settings": [] } },
    });
    render(<KeyboardShortcuts />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Modified" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(within(screen.getByRole("listitem")).getByText("page.settings")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reset all shortcuts" }));
    const dialog = useDialogs.getState().dialog;
    expect(dialog.kind).toBe("confirm");
    if (dialog.kind === "confirm")
      await act(async () => {
        await dialog.onConfirm();
      });
    expect(useSettings.getState().settings.keyboardShortcuts).toEqual({});
  });
});
