import type { ShortcutCommand } from "./registry";

export type ShortcutPropagation = "consume" | "continue" | "block";
export interface ShortcutRule {
  priority: number;
  propagation: ShortcutPropagation;
}
export type ShortcutRules = Record<string, Record<string, ShortcutRule>>;

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
