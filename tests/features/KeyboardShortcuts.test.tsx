import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n/i18n";
import { KeyboardShortcuts } from "@/features/settings/KeyboardShortcuts";
import { ShortcutConflictDialog } from "@/features/settings/ShortcutConflictDialog";
import { SHORTCUT_COMMANDS } from "@/lib/keyboard/registry";
import { DEFAULT_SETTINGS } from "@/lib/prefs/defaults";
import { useSettings } from "@/store/settings";
import { useShortcutConflicts } from "@/store/shortcutConflicts";
import { useDialogs } from "@/store/dialogs";
import { usePlugins } from "@/store/plugins";

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
  usePlugins.setState({ items: [] });
  useShortcutConflicts.setState({ query: "", request: 0, queue: [], resolving: false });
});
const search = (value: string) =>
  fireEvent.change(screen.getByRole("textbox", { name: "Search commands or shortcuts" }), {
    target: { value },
  });

describe("KeyboardShortcuts", () => {
  it("reviews all queued plugin conflicts in settings without another modal blocking it", () => {
    const plugin = {
      id: "formatter",
      name: "Formatter",
      runtime: "node",
      views: [],
      commands: [{ id: "format", title: "Format", keybindings: ["Mod+Shift+F", "Mod+Alt+J"] }],
    };
    usePlugins.setState({ items: [plugin, { ...plugin, id: "other", name: "Other" }] as never });
    useShortcutConflicts
      .getState()
      .enqueue(undefined, plugin as never, usePlugins.getState().items);
    expect(useShortcutConflicts.getState().queue.length).toBeGreaterThan(1);
    render(<ShortcutConflictDialog />);
    fireEvent.click(screen.getByRole("button", { name: "Resolve in settings" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(useShortcutConflicts.getState().queue).toEqual([]);
    expect(useShortcutConflicts.getState().query).toBe("@is:conflict & @plugins:formatter,other");
    expect(useSettings.getState().settings.keyboardShortcuts).toEqual({});
  });
  it("disables competing conflict choices while persisting without trapping the dialog", () => {
    usePlugins.setState({
      items: [
        {
          id: "formatter",
          name: "Formatter",
          runtime: "node",
          views: [],
          commands: [{ id: "format", title: "Format", keybindings: ["Mod+Shift+F"] }],
        },
      ] as never,
    });
    useShortcutConflicts.setState({
      resolving: true,
      queue: [
        {
          incoming: "plugin.c.9.formatter.format",
          existing: "palette.content",
          binding: "Mod+Shift+F",
        },
      ],
    });
    render(<ShortcutConflictDialog />);
    const choices = document.querySelectorAll<HTMLButtonElement>(
      ".shortcuts-conflict-options button",
    );
    expect(choices).toHaveLength(2);
    expect([...choices].every((button) => button.disabled)).toBe(true);
    const keep = screen.getByRole("button", { name: "Keep conflict" });
    expect(keep).toHaveProperty("disabled", false);
    fireEvent.click(keep);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("inserts and removes conflict filters from a discoverable menu, retaining text and focus", () => {
    render(<KeyboardShortcuts />);
    search("page.settings");
    fireEvent.click(screen.getByRole("button", { name: "Filter shortcuts" }));
    expect(screen.getByText("@is:conflict")).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Conflicting shortcuts" }));
    const input = screen.getByRole("textbox", { name: "Search commands or shortcuts" });
    expect(input).toHaveProperty("value", "page.settings @is:conflict");
    expect(document.activeElement).toBe(input);
    fireEvent.click(screen.getByRole("button", { name: "Filter shortcuts" }));
    expect(
      screen
        .getByRole("menuitemcheckbox", { name: "Conflicting shortcuts" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("menuitem", { name: "Clear filters" }));
    expect(input).toHaveProperty("value", "page.settings");
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
  });
  it("synchronizes typed modified filters with the checkbox and supports clearing an unassigned filter", () => {
    render(<KeyboardShortcuts />);
    search("@IS:MODIFIED");
    expect(screen.getByRole("checkbox", { name: "Modified" })).toHaveProperty("checked", true);
    fireEvent.click(screen.getByRole("checkbox", { name: "Modified" }));
    expect(screen.getByRole("textbox", { name: "Search commands or shortcuts" })).toHaveProperty(
      "value",
      "",
    );
    fireEvent.click(screen.getByRole("button", { name: "Filter shortcuts" }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Unassigned commands" }));
    expect(
      screen.getAllByRole("listitem").every((row) => within(row).queryByText("Unassigned")),
    ).toBe(true);
  });
  it("offers installed plugins and combines their selection with related conflicts", () => {
    usePlugins.setState({
      items: [
        {
          id: "formatter",
          name: "Formatter",
          runtime: "node",
          views: [],
          commands: [{ id: "format", title: "Format", keybindings: ["Mod+Comma"] }],
        },
      ] as never,
    });
    render(<KeyboardShortcuts />);
    fireEvent.click(screen.getByRole("button", { name: "Filter shortcuts" }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Formatter" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Filter shortcuts" }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Conflicting shortcuts" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("page.settings")).toBeTruthy();
  });
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
  it("warns about conflicting bindings and preserves the previous shortcut on cancel", () => {
    render(<KeyboardShortcuts />);
    search("page.settings");
    fireEvent.click(screen.getByRole("button", { name: "Edit: Settings Ctrl+," }));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Press a shortcut" }), {
      key: "k",
      ctrlKey: true,
    });
    expect(screen.getByRole("alert").textContent).toContain("Quick Access");
    expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(false);
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
  it("saves per-binding advanced behavior and keeps details opt-in", async () => {
    render(<KeyboardShortcuts />);
    search("page.settings");
    fireEvent.click(screen.getByRole("button", { name: "Advanced shortcut settings: Settings" }));
    fireEvent.change(screen.getByRole("spinbutton", { name: "Priority" }), {
      target: { value: "250" },
    });
    fireEvent.click(screen.getByRole("button", { name: "After handling Ctrl+," }));
    fireEvent.click(screen.getByRole("option", { name: "Continue passing through" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save" })));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(useSettings.getState().settings.shortcutRules).toEqual({
      "page.settings": { "Mod+Comma": { priority: 250, propagation: "continue" } },
    });
    expect(document.querySelector(".shortcuts__details")).toBeNull();
    await act(async () =>
      fireEvent.click(screen.getByRole("switch", { name: "Show advanced details" })),
    );
    expect(document.querySelector(".shortcuts__details")?.textContent).toContain("250");
    expect(document.querySelector(".shortcuts__details")?.textContent).toContain(
      "Continue passing through",
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Modified" }));
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Reset: Settings" })));
    expect(useSettings.getState().settings.shortcutRules).toEqual({});
    expect(useSettings.getState().settings.keyboardShortcuts).toEqual({});
  });
  it("validates priority, discards cancel, and retains the dialog after a failed save", async () => {
    render(<KeyboardShortcuts />);
    search("page.settings");
    fireEvent.click(screen.getByRole("button", { name: "Advanced shortcut settings: Settings" }));
    fireEvent.change(screen.getByRole("spinbutton", { name: "Priority" }), {
      target: { value: "1001" },
    });
    expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", true);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(useSettings.getState().settings.shortcutRules).toEqual({});
    fireEvent.click(screen.getByRole("button", { name: "Advanced shortcut settings: Settings" }));
    expect(screen.getByRole("spinbutton", { name: "Priority" })).toHaveProperty("value", "0");
    act(() => useSettings.setState({ update: vi.fn(async () => false) }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save" })));
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
  it("sorts all commands by priority and edits multiple bindings independently", async () => {
    render(<KeyboardShortcuts />);
    search("palette.open");
    fireEvent.click(
      screen.getByRole("button", { name: "Advanced shortcut settings: Quick Access" }),
    );
    const priorities = screen.getAllByRole("spinbutton", { name: "Priority" });
    expect(priorities).toHaveLength(3);
    fireEvent.change(priorities[1]!, { target: { value: "700" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save" })));
    expect(useSettings.getState().settings.shortcutRules["palette.open"]?.["F1"]?.priority).toBe(0);
    expect(useSettings.getState().settings.shortcutRules["palette.open"]?.["Mod+K"]?.priority).toBe(
      700,
    );
    search("");
    fireEvent.click(screen.getByRole("button", { name: "Shortcut order" }));
    fireEvent.click(screen.getByRole("option", { name: "Priority: high to low" }));
    expect(screen.getAllByRole("listitem")[0]?.textContent).toContain("palette.open");
  });
});
