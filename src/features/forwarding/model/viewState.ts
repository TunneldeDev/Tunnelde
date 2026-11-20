/** Ephemeral UI drafts only: no connection authority, credentials or native handles. */
import type { ForwardGroup, ForwardRule } from "./contract";

export type ForwardDraft = ForwardRule & { revision?: string };
export type ForwardEditorDraft = Omit<ForwardDraft, "bindPort" | "targetPort"> & {
  bindPort: string;
  targetPort: string;
};
export type ForwardGroupEditor = { hostId: string; group?: ForwardGroup } | null;
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string";
function base(value: unknown, hostId: string): value is Record<string, unknown> {
  return (
    record(value) &&
    value.hostId === hostId &&
    text(value.id) &&
    text(value.name) &&
    (value.mode === "local" || value.mode === "remote") &&
    text(value.bindHost) &&
    text(value.targetHost) &&
    (value.groupId === undefined || value.groupId === null || text(value.groupId)) &&
    (value.automation === undefined ||
      (record(value.automation) &&
        typeof value.automation.autoStart === "boolean" &&
        typeof value.automation.autoRetry === "boolean"))
  );
}
export function forwardDraft(value: unknown, hostId: string): value is ForwardDraft | null {
  return (
    value === null ||
    (base(value, hostId) &&
      typeof value.bindPort === "number" &&
      Number.isFinite(value.bindPort) &&
      typeof value.targetPort === "number" &&
      Number.isFinite(value.targetPort) &&
      (value.revision === undefined || text(value.revision)))
  );
}
export function editorDraft(value: unknown, rule: ForwardDraft): value is ForwardEditorDraft {
  return (
    base(value, rule.hostId) &&
    value.id === rule.id &&
    value.revision === rule.revision &&
    text(value.bindPort) &&
    text(value.targetPort)
  );
}
export function groupEditor(value: unknown, hostId: string): value is ForwardGroupEditor {
  return (
    value === null ||
    (record(value) &&
      value.hostId === hostId &&
      (value.group === undefined ||
        (record(value.group) &&
          value.group.hostId === hostId &&
          text(value.group.id) &&
          text(value.group.name) &&
          text(value.group.revision))))
  );
}
export function forwardingSelection(
  value: unknown,
): value is { hostId: string | null; targetRevision: number } {
  return (
    record(value) &&
    (value.hostId === null || text(value.hostId)) &&
    typeof value.targetRevision === "number" &&
    Number.isSafeInteger(value.targetRevision) &&
    value.targetRevision >= 0
  );
}
