import { afterEach, expect, it } from "vitest";
import { terminalEditingSequence } from "@/features/terminal/terminalKeyboard";
import { bindingsFor } from "@/lib/keyboard/registry";
const platform = Object.getOwnPropertyDescriptor(navigator, "platform");
afterEach(() => {
  if (platform) Object.defineProperty(navigator, "platform", platform);
  else Reflect.deleteProperty(navigator, "platform");
});
it("only adds platform-specific editing defaults and supports custom bindings and disabling", () => {
  Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
  const key = new KeyboardEvent("keydown", { key: "ArrowLeft", metaKey: true });
  expect(terminalEditingSequence(key, {})).toBe("\x01");
  expect(terminalEditingSequence(key, { "terminal.lineStart": [] })).toBeNull();
  expect(bindingsFor("terminal.lineStart", {}, false)).toEqual([]);
  Object.defineProperty(navigator, "platform", { configurable: true, value: "Win32" });
  expect(terminalEditingSequence(key, {})).toBeNull();
  expect(
    terminalEditingSequence(new KeyboardEvent("keydown", { key: "h", ctrlKey: true }), {
      "terminal.lineStart": ["Ctrl+H"],
    }),
  ).toBe("\x01");
});
it("leaves cursor modes, IME, AltGr, keyup and consumed events to xterm", () => {
  Object.defineProperty(navigator, "platform", { configurable: true, value: "MacIntel" });
  for (const event of [
    new KeyboardEvent("keyup", { key: "ArrowLeft", metaKey: true }),
    new KeyboardEvent("keydown", { key: "ArrowLeft" }),
    new KeyboardEvent("keydown", { key: "ArrowLeft", ctrlKey: true }),
    new KeyboardEvent("keydown", { key: "ArrowLeft", metaKey: true, shiftKey: true }),
    new KeyboardEvent("keydown", { key: "ArrowLeft", metaKey: true, isComposing: true }),
    new KeyboardEvent("keydown", { key: "ArrowLeft", metaKey: true, keyCode: 229 }),
  ])
    expect(terminalEditingSequence(event, {})).toBeNull();
  const consumed = new KeyboardEvent("keydown", {
    key: "ArrowLeft",
    metaKey: true,
    cancelable: true,
  });
  consumed.preventDefault();
  expect(terminalEditingSequence(consumed, {})).toBeNull();
});
