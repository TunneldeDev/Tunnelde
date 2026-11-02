import { describe, expect, it } from "vitest";
import {
  bindingsFor,
  matchesCommand,
  normalizeShortcut,
  recordShortcut,
  shortcutConflict,
  terminalAllowsCommand,
} from "@/lib/keyboard/registry";

const key = (options: KeyboardEventInit) => new KeyboardEvent("keydown", options);

describe("application keyboard registry", () => {
  it("matches settings on the physical comma key with a Chinese punctuation value", () => {
    for (const primary of [{ ctrlKey: true }, { metaKey: true }]) {
      expect(matchesCommand(key({ key: "，", code: "Comma", ...primary }), "page.settings")).toBe(
        true,
      );
      expect(matchesCommand(key({ key: ",", ...primary }), "page.settings")).toBe(true);
    }
  });
  it("replaces defaults, supports explicit disable, and restores defaults by removing an override", () => {
    const custom = { "page.settings": ["Mod+Shift+Y"] };
    expect(matchesCommand(key({ key: ",", ctrlKey: true }), "page.settings", custom)).toBe(false);
    expect(
      matchesCommand(key({ key: "Y", ctrlKey: true, shiftKey: true }), "page.settings", custom),
    ).toBe(true);
    expect(bindingsFor("page.settings", { "page.settings": [] })).toEqual([]);
    expect(bindingsFor("page.settings", {})).toEqual(["Mod+Comma"]);
  });
  it("records canonical bindings and rejects composition, AltGr and modifier-only input", () => {
    expect(recordShortcut(key({ key: "，", code: "Comma", ctrlKey: true }))).toBe("Mod+Comma");
    expect(recordShortcut(key({ key: "Control", ctrlKey: true }))).toBeNull();
    expect(recordShortcut(key({ key: "k", ctrlKey: true, altKey: true }))).toBeNull();
    expect(
      matchesCommand(key({ key: ",", ctrlKey: true, isComposing: true }), "page.settings"),
    ).toBe(false);
    expect(normalizeShortcut("Mod+Ctrl+K")).toBeNull();
  });
  it("rejects conflicts in a shared context while allowing file and workbench context precedence", () => {
    expect(shortcutConflict("page.settings", "Ctrl+K", {})?.id).toBe("palette.open");
    expect(shortcutConflict("files.rename", "Mod+C", {})?.id).toBe("files.copy");
    expect(shortcutConflict("files.newFile", "Mod+N", {})).toBeUndefined();
    expect(matchesCommand(key({ key: "n", ctrlKey: true }), "files.newFile")).toBe(true);
    expect(matchesCommand(key({ key: "n", ctrlKey: true }), "host.new")).toBe(true);
  });
  it("preserves shell control chords while permitting settings and deliberate terminal-safe commands", () => {
    expect(terminalAllowsCommand(key({ key: "k", ctrlKey: true }), "palette.open", {})).toBe(false);
    expect(terminalAllowsCommand(key({ key: ",", ctrlKey: true }), "page.settings", {})).toBe(true);
    expect(
      terminalAllowsCommand(key({ key: "|", ctrlKey: true, shiftKey: true }), "tab.splitDown", {}),
    ).toBe(false);
    expect(
      terminalAllowsCommand(key({ key: "Y", ctrlKey: true, shiftKey: true }), "sidebar.toggle", {
        "sidebar.toggle": ["Mod+Shift+Y"],
      }),
    ).toBe(true);
  });
});
