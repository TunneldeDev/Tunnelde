import { useState } from "react";
import { create } from "zustand";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n/i18n";
import {
  KeyboardShortcutsView,
  type KeyboardShortcutsData,
  type KeyboardShortcutsServices,
} from "@/features/settings/components/KeyboardShortcutsView";
import { changeShortcutSettings } from "@/features/settings/data/shortcutMutations";
import { SHORTCUT_COMMANDS, type ShortcutCommand } from "@/lib/keyboard/registry";
import { toggleShortcutFilter } from "@/lib/keyboard/query";

vi.mock("@/store/settings", () => {
  throw new Error("Shortcut view imported main settings owner");
});
vi.mock("@/store/shortcutConflicts", () => {
  throw new Error("Shortcut view imported main conflicts owner");
});
vi.mock("@/store/plugins", () => {
  throw new Error("Shortcut view imported main plugin owner");
});
vi.mock("@/store/dialogs", () => {
  throw new Error("Shortcut view imported main consent owner");
});
vi.mock("@/lib/api/ipc", () => {
  throw new Error("Shortcut view imported direct IPC");
});

function fixture() {
  const state = create<KeyboardShortcutsData>(() => ({
    definitions: SHORTCUT_COMMANDS,
    plugins: [],
    overrides: {},
    rules: {},
    showDetails: false,
    saving: false,
    query: "page.settings",
  }));
  const captured = new Map<string, unknown>();
  const services: KeyboardShortcutsServices = {
    useData: state,
    useViewState<T>(key: string, initial: T) {
      const [value, setValue] = useState<T>(() =>
        captured.has(key) ? (captured.get(key) as T) : initial,
      );
      captured.set(key, value);
      return [value, setValue];
    },
    useBusyGuard: vi.fn(),
    setQuery: vi.fn((query) => state.setState({ query })),
    toggleFilter: vi.fn((key, value) =>
      state.setState((s) => ({ query: toggleShortcutFilter(s.query, key, value) })),
    ),
    change: vi.fn(async () => true),
    confirm: vi.fn(),
  };
  const mount = () => render(<KeyboardShortcutsView services={services} />);
  return { state, services, captured, mount };
}
beforeEach(async () => {
  await i18n.changeLanguage("en-US");
});

describe("keyboard settings document-local boundary", () => {
  it("captures a recorded binding across remount and retains the recorder after a rejected save", async () => {
    const owner = fixture();
    const view = owner.mount();
    fireEvent.click(screen.getByRole("button", { name: "Edit: Settings Ctrl+," }));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Press a shortcut" }), {
      key: "y",
      ctrlKey: true,
    });
    view.unmount();
    owner.mount();
    expect(screen.getByRole("textbox", { name: "Press a shortcut" })).toHaveProperty(
      "value",
      "Ctrl+Y",
    );
    vi.mocked(owner.services.change).mockResolvedValueOnce(false);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save" })));
    expect(screen.getByRole("textbox", { name: "Press a shortcut" })).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save" })));
    expect(owner.services.change).toHaveBeenLastCalledWith({
      kind: "bind",
      id: "page.settings",
      previous: "Mod+Comma",
      binding: "Mod+Y",
    });
    expect(screen.queryByRole("textbox", { name: "Press a shortcut" })).toBeNull();
  });

  it("captures an unfinished advanced-rule draft without persisting invalid priority", async () => {
    const owner = fixture();
    const view = owner.mount();
    fireEvent.click(screen.getByRole("button", { name: "Advanced shortcut settings: Settings" }));
    fireEvent.change(screen.getByRole("spinbutton", { name: "Priority" }), {
      target: { value: "-" },
    });
    view.unmount();
    owner.mount();
    expect(screen.getByRole("spinbutton", { name: "Priority" })).toHaveProperty("value", "");
    expect(screen.getByRole("button", { name: "Save" })).toHaveProperty("disabled", true);
    expect(owner.services.change).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("spinbutton", { name: "Priority" }), {
      target: { value: "250" },
    });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Save" })));
    expect(owner.services.change).toHaveBeenCalledWith({
      kind: "rules",
      id: "page.settings",
      value: { "Mod+Comma": { priority: 250, propagation: "consume" } },
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("delegates filters and destructive reset consent to the owner", async () => {
    const owner = fixture();
    owner.state.setState({ overrides: { "page.settings": ["Mod+Y"] } });
    owner.mount();
    fireEvent.click(screen.getByRole("checkbox", { name: "Modified" }));
    expect(owner.services.toggleFilter).toHaveBeenCalledWith("is", "modified");
    expect(screen.getByRole("textbox", { name: "Search commands or shortcuts" })).toHaveProperty(
      "value",
      "page.settings @is:modified",
    );
    fireEvent.click(screen.getByRole("button", { name: "Reset all shortcuts" }));
    expect(owner.services.change).not.toHaveBeenCalled();
    await act(async () => vi.mocked(owner.services.confirm).mock.calls[0]![0].onConfirm());
    expect(owner.services.change).toHaveBeenCalledWith({ kind: "reset", id: null });
  });

  it("guards an in-flight save against background release", async () => {
    const owner = fixture();
    let finish!: (value: boolean) => void;
    vi.mocked(owner.services.change).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    owner.mount();
    fireEvent.click(screen.getByRole("button", { name: "Delete: Settings Ctrl+," }));
    expect(owner.services.useBusyGuard).toHaveBeenLastCalledWith(true);
    expect(screen.getByRole("button", { name: "Delete: Settings Ctrl+," })).toHaveProperty(
      "disabled",
      true,
    );
    await act(async () => finish(true));
    expect(owner.services.useBusyGuard).toHaveBeenLastCalledWith(false);
  });

  it("merges one binding and transfers its rule without replacing unrelated owner changes", () => {
    const settings = {
      keyboardShortcuts: { "page.settings": ["Mod+Comma"], "palette.open": ["F2"] },
      shortcutRules: {
        "page.settings": { "Mod+Comma": { priority: 200, propagation: "continue" as const } },
        "palette.open": { F2: { priority: 900, propagation: "consume" as const } },
      },
    };
    expect(
      changeShortcutSettings(settings, SHORTCUT_COMMANDS, {
        kind: "bind",
        id: "page.settings",
        previous: "Mod+Comma",
        binding: "Mod+Y",
      }),
    ).toEqual({
      keyboardShortcuts: { ...settings.keyboardShortcuts, "page.settings": ["Mod+Y"] },
      shortcutRules: {
        ...settings.shortcutRules,
        "page.settings": { "Mod+Y": settings.shortcutRules["page.settings"]["Mod+Comma"] },
      },
    });
    expect(settings.keyboardShortcuts["page.settings"]).toEqual(["Mod+Comma"]);
    expect(
      changeShortcutSettings(settings, SHORTCUT_COMMANDS, {
        kind: "remove",
        id: "page.settings",
        binding: "Mod+Comma",
      }),
    ).toEqual({
      keyboardShortcuts: { ...settings.keyboardShortcuts, "page.settings": [] },
      shortcutRules: { "palette.open": settings.shortcutRules["palette.open"] },
    });
  });

  it("rejects vanished commands, stale binding edits and a fifth binding", () => {
    const settings = { keyboardShortcuts: { "page.settings": ["Mod+Y"] }, shortcutRules: {} };
    expect(changeShortcutSettings(settings, [], { kind: "reset", id: "page.settings" })).toBeNull();
    expect(
      changeShortcutSettings(settings, SHORTCUT_COMMANDS, {
        kind: "bind",
        id: "page.settings",
        previous: "Mod+Comma",
        binding: "F2",
      }),
    ).toBeNull();
    expect(
      changeShortcutSettings(
        { ...settings, keyboardShortcuts: { "page.settings": ["F1", "F2", "F3", "F4"] } },
        SHORTCUT_COMMANDS,
        { kind: "bind", id: "page.settings", previous: null, binding: "F5" },
      ),
    ).toBeNull();
  });

  it("uses bounded capture keys even for long contributed command identities", () => {
    const owner = fixture();
    const command: ShortcutCommand = {
      id: `plugin.${"a".repeat(180)}`,
      label: "",
      title: "Long command",
      scope: "workbench",
      defaults: ["F2"],
    };
    owner.state.setState({ definitions: [command], query: "" });
    owner.mount();
    fireEvent.click(
      screen.getByRole("button", { name: "Advanced shortcut settings: Long command" }),
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect([...owner.captured.keys()].every((key) => key.length <= 128)).toBe(true);
  });
});
