import type { PluginInfo } from "@/lib/api/types";

export type ShortcutOverrides = Record<string, string[]>;
export type CommandScope = "workbench" | "files" | "editor" | "terminal";

export interface ShortcutCommand {
  id: string;
  label: string;
  scope: CommandScope;
  defaults: string[];
  macDefaults?: string[];
  input?: boolean;
  title?: string;
  plugin?: { id: string; command?: string; view?: string };
}

const command = (
  id: string,
  label: string,
  scope: CommandScope,
  defaults: string[],
  extra: Partial<ShortcutCommand> = {},
): ShortcutCommand => ({ id, label, scope, defaults, ...extra });

/** Application commands, shared by the router, palette and keyboard editor.
 * Widget navigation (arrows, Escape, Tab) remains local to each widget. */
export const SHORTCUT_COMMANDS: ShortcutCommand[] = [
  command("palette.open", "palette.title", "workbench", ["F1", "Mod+K", "Mod+Shift+P"], {
    input: true,
  }),
  command("palette.files", "palette.files", "workbench", ["Mod+P"], { input: true }),
  command("palette.content", "palette.content", "workbench", ["Mod+Shift+F"], { input: true }),
  command("page.settings", "nav.settings", "workbench", ["Mod+Comma"], { input: true }),
  command("keyboard.shortcuts", "shortcuts.title", "workbench", ["Mod+Shift+F12"], { input: true }),
  command("host.new", "sidebar.newHost", "workbench", ["Mod+N", "Mod+Shift+N"]),
  command("sidebar.toggle", "shortcuts.toggleSidebar", "workbench", ["Mod+B"]),
  command("page.welcome", "nav.welcome", "workbench", []),
  command("page.about", "nav.about", "workbench", []),
  command("sidebar.knownHosts", "settings.knownHosts", "workbench", []),
  command("sidebar.plugins", "settings.plugins", "workbench", []),
  command("update.check", "updates.check", "workbench", []),
  command("panel.toggle", "shortcuts.togglePanel", "workbench", []),
  command("theme.cycle", "shortcuts.cycleTheme", "workbench", []),
  command("font.increase", "shortcuts.fontIncrease", "workbench", [
    "Mod+Equal",
    "Mod+Shift+Equal",
    "Mod+Plus",
  ]),
  command("font.decrease", "shortcuts.fontDecrease", "workbench", ["Mod+Minus"]),
  command("font.reset", "shortcuts.fontReset", "workbench", ["Mod+0"]),
  command("tab.close", "tab.close", "workbench", ["Mod+W"]),
  command("tab.keepOpen", "tab.keepOpen", "workbench", []),
  command("pane.close", "shortcuts.closePane", "workbench", ["Mod+Shift+W"]),
  command("tab.splitRight", "tab.splitRight", "workbench", ["Mod+Backslash"]),
  command("tab.splitDown", "tab.splitDown", "workbench", ["Mod+Shift+Backslash"]),
  command("tab.next", "shortcuts.nextTab", "workbench", ["Mod+Tab"]),
  command("tab.previous", "shortcuts.previousTab", "workbench", ["Mod+Shift+Tab"]),
  ...Array.from({ length: 9 }, (_, i) =>
    command(`tab.focus${i + 1}`, "shortcuts.focusTab", "workbench", [`Mod+${i + 1}`]),
  ),
  command("editor.save", "editor.save", "editor", ["Mod+S"]),
  command("terminal.copy", "terminal.copy", "terminal", ["Mod+C", "Mod+Shift+C", "Ctrl+Insert"], {
    macDefaults: ["Meta+C", "Meta+Shift+C"],
  }),
  command(
    "terminal.paste",
    "terminal.paste",
    "terminal",
    ["Mod+V", "Mod+Shift+V", "Shift+Insert"],
    { macDefaults: ["Meta+V", "Meta+Shift+V"] },
  ),
  command("files.filter", "sftp.filterFiles", "files", ["Mod+F"]),
  command("files.path", "shortcuts.focusPath", "files", ["Mod+L"]),
  command("files.hidden", "sftp.showHidden", "files", ["Mod+H", "Meta+Shift+Period"]),
  command("files.back", "shortcuts.goBack", "files", ["Alt+ArrowLeft"]),
  command("files.forward", "shortcuts.goForward", "files", ["Alt+ArrowRight"]),
  command("files.parent", "sftp.up", "files", ["Alt+ArrowUp", "Meta+ArrowUp", "Backspace"]),
  command("files.refresh", "sftp.refresh", "files", ["F5"]),
  command("files.selectAll", "shortcuts.selectAll", "files", ["Mod+A"]),
  command("files.copy", "common.copy", "files", ["Mod+C"]),
  command("files.cut", "sftp.cut", "files", ["Mod+X"]),
  command("files.paste", "common.paste", "files", ["Mod+V"]),
  command("files.newFile", "sftp.newFile", "files", ["Mod+N"]),
  command("files.newFolder", "sftp.newFolder", "files", ["Mod+Shift+N"]),
  command("files.open", "common.open", "files", ["Enter", "Meta+ArrowDown"]),
  command("files.preview", "sftp.preview", "files", ["Space"]),
  command("files.rename", "sftp.rename", "files", ["F2"]),
  command("files.delete", "common.delete", "files", ["Delete"]),
];

export const isMacKeyboard = () => /Mac|iPhone|iPad/.test(navigator.platform);

/** Manifest metadata is safe to list without starting a plugin or discovering Node. */
export function shortcutCommands(plugins: readonly PluginInfo[] = []): ShortcutCommand[] {
  return [
    ...SHORTCUT_COMMANDS,
    ...plugins
      .filter((plugin) => plugin.runtime !== "theme")
      .flatMap((plugin) => [
        ...plugin.views.map((view) => ({
          id: `plugin.v.${plugin.id.length}.${plugin.id}.${view.id}`,
          label: "pluginView.title",
          title: `${plugin.name}: ${view.title}`,
          scope: "workbench" as const,
          input: true,
          defaults: [],
          plugin: { id: plugin.id, view: view.id },
        })),
        ...plugin.commands.map((item) => ({
          id: `plugin.c.${plugin.id.length}.${plugin.id}.${item.id}`,
          label: "pluginView.run",
          title: `${plugin.name}: ${item.title}`,
          scope: "workbench" as const,
          input: true,
          defaults: [],
          plugin: { id: plugin.id, command: item.id },
        })),
      ]),
  ];
}
const aliases: Record<string, string> = {
  ",": "Comma",
  ".": "Period",
  "\\": "Backslash",
  "|": "Backslash",
  "=": "Equal",
  "+": "Plus",
  "-": "Minus",
  " ": "Space",
  Esc: "Escape",
};
const namedKeys = [
  "Comma",
  "Period",
  "Backslash",
  "Equal",
  "Plus",
  "Minus",
  "Space",
  "Escape",
  "Tab",
  "Enter",
  "Backspace",
  "Delete",
  "Insert",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
];

export function normalizeShortcut(value: string): string | null {
  const parts = value
    .trim()
    .split("+")
    .map((part) => part.trim());
  const raw = parts.pop();
  if (!raw || parts.some((part) => !["Mod", "Ctrl", "Meta", "Alt", "Shift"].includes(part)))
    return null;
  const modifiers = [...new Set(parts)];
  if (
    modifiers.length !== parts.length ||
    (modifiers.includes("Mod") && (modifiers.includes("Ctrl") || modifiers.includes("Meta"))) ||
    (modifiers.includes("Ctrl") && modifiers.includes("Meta"))
  )
    return null;
  const key =
    aliases[raw] ??
    namedKeys.find((item) => item.toLowerCase() === raw.toLowerCase()) ??
    (/^[a-z0-9]$/i.test(raw) || /^F([1-9]|1[0-9]|2[0-4])$/i.test(raw) ? raw.toUpperCase() : null);
  if (!key) return null;
  return [
    ...["Mod", "Ctrl", "Meta", "Alt", "Shift"].filter((part) => modifiers.includes(part)),
    key,
  ].join("+");
}

type KeyEvent = Pick<
  KeyboardEvent,
  "key" | "code" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "isComposing"
> & { keyCode?: number };
function eventKey(event: KeyEvent): string {
  if (["Comma", "Period", "Backslash", "Equal", "Minus"].includes(event.code)) return event.code;
  return aliases[event.key] ?? event.key.toUpperCase();
}

export function shortcutMatches(event: KeyEvent, binding: string): boolean {
  if (
    event.isComposing ||
    event.keyCode === 229 ||
    (event.ctrlKey && event.altKey) ||
    (event.ctrlKey && event.metaKey)
  )
    return false;
  const normalized = normalizeShortcut(binding);
  if (!normalized) return false;
  const parts = normalized.split("+");
  const key = parts.pop()!;
  const mod = parts.includes("Mod");
  if (
    (mod
      ? !(event.ctrlKey !== event.metaKey)
      : event.ctrlKey !== parts.includes("Ctrl") || event.metaKey !== parts.includes("Meta")) ||
    event.altKey !== parts.includes("Alt") ||
    event.shiftKey !== parts.includes("Shift")
  )
    return false;
  return eventKey(event).toLowerCase() === key.toLowerCase();
}

export function bindingsFor(
  id: string,
  overrides: ShortcutOverrides = {},
  mac = isMacKeyboard(),
  definitions: readonly ShortcutCommand[] = SHORTCUT_COMMANDS,
): string[] {
  const definition = definitions.find((item) => item.id === id);
  if (!definition) return [];
  const own = overrides[id];
  return Array.isArray(own)
    ? own
        .filter((value) => typeof value === "string" && normalizeShortcut(value) !== null)
        .slice(0, 4)
    : ((mac ? definition.macDefaults : undefined) ?? definition.defaults);
}

export function matchesCommand(
  event: KeyEvent,
  id: string,
  overrides: ShortcutOverrides = {},
  definitions: readonly ShortcutCommand[] = SHORTCUT_COMMANDS,
): boolean {
  return bindingsFor(id, overrides, undefined, definitions).some((binding) =>
    shortcutMatches(event, binding),
  );
}

export function recordShortcut(event: KeyEvent): string | null {
  if (
    event.isComposing ||
    event.keyCode === 229 ||
    (event.ctrlKey && event.altKey) ||
    (event.ctrlKey && event.metaKey)
  )
    return null;
  const key = eventKey(event);
  const primary = isMacKeyboard() ? event.metaKey : event.ctrlKey;
  return normalizeShortcut(
    [
      ...(primary ? ["Mod"] : []),
      ...(event.ctrlKey && !primary ? ["Ctrl"] : []),
      ...(event.metaKey && !primary ? ["Meta"] : []),
      ...(event.altKey ? ["Alt"] : []),
      ...(event.shiftKey ? ["Shift"] : []),
      key,
    ].join("+"),
  );
}

export function displayShortcut(binding: string, mac = isMacKeyboard()): string {
  return binding
    .split("+")
    .map(
      (part) =>
        ({
          Mod: mac ? "⌘" : "Ctrl",
          Meta: "⌘",
          Ctrl: "Ctrl",
          Alt: mac ? "⌥" : "Alt",
          Shift: "Shift",
          Comma: ",",
          Period: ".",
          Equal: "=",
          Plus: "+",
          Minus: "−",
          Backslash: "\\",
        })[part] ?? part,
    )
    .join("+");
}

/** Scoped commands take priority over workbench commands. Distinct scopes can
 * intentionally share keys (for example New File and New Host). */
export function shortcutConflict(
  id: string,
  binding: string,
  overrides: ShortcutOverrides,
  definitions: readonly ShortcutCommand[] = SHORTCUT_COMMANDS,
): ShortcutCommand | undefined {
  const own = definitions.find((item) => item.id === id);
  const variants = (value: string) =>
    [false, true].map((mac) => displayShortcut(normalizeShortcut(value) ?? value, mac));
  return definitions.find(
    (item) =>
      item.id !== id &&
      item.scope === own?.scope &&
      bindingsFor(item.id, overrides, undefined, definitions).some((other) =>
        variants(binding).some((value, i) => value === variants(other)[i]),
      ),
  );
}

export function isTextTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    !!target.closest("input, textarea, [contenteditable='true'], [role='textbox']")
  );
}

export function terminalAllowsCommand(
  event: KeyEvent,
  id: string,
  overrides: ShortcutOverrides,
): boolean {
  if (!event.ctrlKey || event.metaKey) return true;
  if (
    id === "page.settings" ||
    id === "keyboard.shortcuts" ||
    id.startsWith("font.") ||
    id === "tab.next" ||
    id === "tab.previous"
  )
    return true;
  if (["palette.open", "palette.content", "host.new", "pane.close"].includes(id))
    return event.shiftKey;
  return Array.isArray(overrides[id]) && event.shiftKey;
}
