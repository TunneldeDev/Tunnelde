import { useSettings } from "@/store/settings";
import { usePlugins } from "@/store/plugins";
import { runWorkbenchCommand } from "./actions";
import {
  bindingsFor,
  isTextTarget,
  shortcutCommands,
  shortcutMatches,
  terminalAllowsCommand,
  type ShortcutCommand,
} from "./registry";

export type ShortcutPropagation = "consume" | "continue" | "block";
export interface ShortcutRule {
  priority: number;
  propagation: ShortcutPropagation;
}
export type ShortcutRules = Record<string, Record<string, ShortcutRule>>;
export interface ShortcutCandidate {
  command: ShortcutCommand;
  binding: string;
  run: () => boolean;
}
export interface ShortcutResult {
  handled: boolean;
  consumed: boolean;
}
const COLLECTION = "tunnelde:collect-shortcuts";
const results = new WeakMap<KeyboardEvent, ShortcutResult>();
type Collector = { event: KeyboardEvent; candidates: ShortcutCandidate[] };

export function shortcutRule(
  command: ShortcutCommand,
  binding: string,
  rules: ShortcutRules = {},
): ShortcutRule {
  const own = rules[command.id]?.[binding];
  return {
    priority:
      own && Number.isInteger(own.priority)
        ? Math.max(-1000, Math.min(1000, own.priority))
        : command.scope === "workbench"
          ? 0
          : 100,
    propagation:
      own && ["continue", "block"].includes(own.propagation) ? own.propagation : "consume",
  };
}

/** Synchronous acceptance is the success boundary: async work can fail later.
 * Do not replay keys into a shell after a failed network request. */
export function executeShortcutCandidates(
  event: KeyboardEvent,
  candidates: readonly ShortcutCandidate[],
  rules: ShortcutRules = {},
): ShortcutResult {
  let handled = false;
  let consumed = false;
  const seen = new Set<string>();
  const ordered = candidates
    .map((candidate, index) => ({
      ...candidate,
      index,
      rule: shortcutRule(candidate.command, candidate.binding, rules),
    }))
    .sort((a, b) => b.rule.priority - a.rule.priority || a.index - b.index);
  for (const candidate of ordered) {
    if (seen.has(candidate.command.id)) continue;
    seen.add(candidate.command.id);
    if (!candidate.run()) continue;
    handled = true;
    if (candidate.rule.propagation !== "continue") consumed = true;
    if (candidate.rule.propagation === "block") break;
  }
  if (consumed) {
    event.preventDefault();
    event.stopPropagation();
  }
  return { handled, consumed };
}

/** Scoped providers advertise only commands they can currently accept. */
export function bindShortcutProvider(
  element: HTMLElement,
  provide: (event: KeyboardEvent) => ShortcutCandidate[],
): () => void {
  const collect = (event: Event) => {
    const detail = (event as CustomEvent<Collector>).detail;
    detail.candidates.push(...provide(detail.event));
  };
  // Also works when a page is mounted outside AppShell (e.g. isolated previews).
  const fallback = (event: KeyboardEvent) => {
    dispatchShortcuts(event, false);
  };
  element.addEventListener(COLLECTION, collect);
  element.addEventListener("keydown", fallback, true);
  return () => {
    element.removeEventListener(COLLECTION, collect);
    element.removeEventListener("keydown", fallback, true);
  };
}

export function scopedShortcutCandidates(
  event: KeyboardEvent,
  ids: readonly string[],
  run: (id: string) => boolean,
): ShortcutCandidate[] {
  const settings = useSettings.getState().settings;
  return shortcutCommands(usePlugins.getState().items)
    .filter((command) => ids.includes(command.id))
    .flatMap((command) => {
      return bindingsFor(command.id, settings.keyboardShortcuts, undefined, [command])
        .filter((key) => shortcutMatches(event, key))
        .map((binding) => ({ command, binding, run: () => run(command.id) }));
    });
}

export function dispatchShortcuts(event: KeyboardEvent, includeWorkbench = true): ShortcutResult {
  const previous = results.get(event);
  if (previous) return previous;
  const empty = { handled: false, consumed: false };
  // Window capture runs before the recorder's input handler. Leave the event
  // untouched so the recorder can capture occupied bindings and handle Tab/Escape.
  if (
    event
      .composedPath()
      .some((target) => target instanceof Element && target.hasAttribute("data-shortcut-recorder"))
  )
    return empty;
  if (
    event.type !== "keydown" ||
    event.defaultPrevented ||
    event.isComposing ||
    event.keyCode === 229 ||
    event.getModifierState("AltGraph") ||
    document.querySelector("[role='dialog'], .td-palette") ||
    (event.target instanceof Element &&
      event.target.closest(
        ".td-select__popup, [role='menu'], [aria-expanded='true'][aria-controls]",
      ))
  )
    return empty;
  const settings = useSettings.getState().settings;
  const definitions = shortcutCommands(usePlugins.getState().items);
  const candidates: ShortcutCandidate[] = [];
  const target = event.target;
  if (target instanceof Element)
    target.dispatchEvent(
      new CustomEvent<Collector>(COLLECTION, { bubbles: true, detail: { event, candidates } }),
    );
  const terminal = target instanceof Element && !!target.closest(".terminal-host");
  // Preserve automatic local ownership (Ctrl+N creates a file, not a host).
  // Explicit rules and plugin conflicts opt into shared, ordered execution.
  const localMatch = candidates.length > 0;
  const global = definitions.filter(
    (command) =>
      command.scope === "workbench" &&
      (!isTextTarget(target) || terminal || command.input) &&
      (!terminal ||
        command.plugin?.command ||
        Object.keys(settings.shortcutRules?.[command.id] ?? {}).some((binding) =>
          shortcutMatches(event, binding),
        ) ||
        terminalAllowsCommand(event, command.id, settings.keyboardShortcuts)),
  );
  const globalCandidates = global.flatMap((command) => {
    return bindingsFor(command.id, settings.keyboardShortcuts, undefined, definitions)
      .filter((key) => shortcutMatches(event, key))
      .map((binding) => ({ command, binding, run: () => runWorkbenchCommand(command.id) }));
  });
  const shared =
    globalCandidates.some(
      (item) =>
        item.command.plugin?.command || settings.shortcutRules?.[item.command.id]?.[item.binding],
    ) ||
    candidates.some(
      (item) => item.command.plugin || settings.shortcutRules?.[item.command.id]?.[item.binding],
    );
  if ((includeWorkbench || candidates.length > 0) && (!localMatch || shared))
    candidates.push(...globalCandidates);
  const result = executeShortcutCandidates(event, candidates, settings.shortcutRules);
  results.set(event, result);
  return result;
}
