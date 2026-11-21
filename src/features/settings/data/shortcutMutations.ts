import type { Settings, SettingsPatch } from "@/lib/api/types";
import { bindingsFor, type ShortcutCommand } from "@/lib/keyboard/registry";
import type { ShortcutRules } from "@/lib/keyboard/rules";
export type ShortcutSettingsChange =
  | { kind: "reset"; id: string | null }
  | { kind: "bind"; id: string; previous: string | null; binding: string }
  | { kind: "remove"; id: string; binding: string }
  | { kind: "rules"; id: string; value: ShortcutRules[string] }
  | { kind: "details"; value: boolean };
/** Merge one command with current owner values. Reject vanished/stale identities. */
export function changeShortcutSettings(
  settings: Pick<Settings, "keyboardShortcuts" | "shortcutRules">,
  definitions: ShortcutCommand[],
  change: ShortcutSettingsChange,
): SettingsPatch | null {
  if (change.kind === "details") return { showShortcutDetails: change.value };
  if (change.kind === "reset" && change.id === null)
    return { keyboardShortcuts: {}, shortcutRules: {} };
  const id = change.id!;
  if (!definitions.some((command) => command.id === id)) return null;
  const overrides = { ...settings.keyboardShortcuts },
    rules = { ...settings.shortcutRules };
  if (change.kind === "reset") {
    delete overrides[id];
    delete rules[id];
  } else if (change.kind === "rules") {
    if (Object.keys(change.value).length) rules[id] = change.value;
    else delete rules[id];
    return { shortcutRules: rules };
  } else {
    const keys = [...bindingsFor(id, overrides, undefined, definitions)];
    const previous = change.kind === "bind" ? change.previous : change.binding;
    const index = previous === null ? keys.length : keys.indexOf(previous);
    if (index < 0 || (previous === null && keys.length >= 4)) return null;
    if (change.kind === "bind") keys.splice(index, previous === null ? 0 : 1, change.binding);
    else keys.splice(index, 1);
    const commandRules = { ...rules[id] };
    if (
      previous &&
      commandRules[previous] &&
      (change.kind === "remove" || previous !== change.binding)
    ) {
      if (change.kind === "bind") commandRules[change.binding] ??= commandRules[previous]!;
      delete commandRules[previous];
      if (Object.keys(commandRules).length) rules[id] = commandRules;
      else delete rules[id];
    }
    overrides[id] = [...new Set(keys)];
  }
  return { keyboardShortcuts: overrides, shortcutRules: rules };
}
