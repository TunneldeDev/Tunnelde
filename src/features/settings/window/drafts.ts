import { parsePanelViewCapsule } from "@/lib/panels/viewState";

export interface SettingsControlDrafts {
  version: 1;
  entries: [string, unknown][];
}
export function isSettingsControlDrafts(value: unknown): value is SettingsControlDrafts {
  if (!value || typeof value !== "object") return false;
  const draft = value as Partial<SettingsControlDrafts>;
  if (draft.version !== 1 || !Array.isArray(draft.entries)) return false;
  const keys = new Set<string>();
  return draft.entries.every((entry) => {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== "string" ||
      !entry[0] ||
      entry[0].length > 4096 ||
      entry[0] === "network:password" ||
      keys.has(entry[0])
    )
      return false;
    keys.add(entry[0]);
    return true;
  });
}
/** One nested capsule field; plugin IDs/fingerprints are data, not 128-byte
 * controller keys. Section unmount does not discard its draft. No secrets here. */
export function createSettingsControlDrafts(initial?: SettingsControlDrafts) {
  const values = new Map<string, unknown>(initial?.entries);
  const listeners = new Set<() => void>();
  let disposed = false;
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    read<T>(key: string, fallback: T): T {
      return values.has(key) ? (values.get(key) as T) : fallback;
    },
    write<T>(key: string, value: T) {
      if (disposed) return;
      if (!key || key.length > 4096 || key === "network:password")
        throw new Error("panel.viewState.invalidKey");
      if (values.has(key) && Object.is(values.get(key), value)) return;
      values.set(key, value);
      for (const listener of listeners) listener();
    },
    capture(): SettingsControlDrafts {
      if (disposed) throw new Error("panel.viewState.disposed");
      // Use the existing strict aggregate JSON bounds, without truncation.
      return parsePanelViewCapsule({
        version: 1,
        fields: { controls: { version: 1, entries: [...values] } },
      }).fields.controls as SettingsControlDrafts;
    },
    dispose() {
      disposed = true;
      values.clear();
      listeners.clear();
    },
  };
}
