import { matchesCommand, type ShortcutOverrides } from "@/lib/keyboard/registry";

const sequences = [
  ["terminal.lineStart", "\x01"],
  ["terminal.lineEnd", "\x05"],
  ["terminal.wordLeft", "\x1bb"],
  ["terminal.wordRight", "\x1bf"],
  ["terminal.deleteLineStart", "\x15"],
  ["terminal.deleteLineEnd", "\x0b"],
] as const;

/** Translate desktop editing gestures to terminal input, not bracketed paste.
 * Defaults are macOS-only; overrides remain available on every platform.
 * Everything else stays with xterm so application cursor and modifier modes work.
 */
export function terminalEditingSequence(
  event: KeyboardEvent,
  overrides: ShortcutOverrides,
): string | null {
  if (
    event.type !== "keydown" ||
    event.defaultPrevented ||
    event.isComposing ||
    event.keyCode === 229 ||
    event.getModifierState("AltGraph")
  )
    return null;
  return sequences.find(([id]) => matchesCommand(event, id, overrides))?.[1] ?? null;
}

export function terminalSequenceFor(
  id: string,
  enhancedKeyboard = false,
  customized = false,
): string | null {
  // Native protocol encoding wins over legacy desktop defaults. An explicit
  // user binding/rule can still opt into the shell editing command.
  if (enhancedKeyboard && !customized) return null;
  return sequences.find(([command]) => command === id)?.[1] ?? null;
}
