import type { PluginFilePreview } from "@/lib/api/types";
import type { FilePreviewContext } from "@/lib/extensions/files/preview/context";
import type { PreviewReadSource } from "./readSource";

/** Main-document coordinator state. Never a plugin API, Bus payload or persisted
 * store. The read and public context outlive every presentation of their body. */
export interface PreviewOwner {
  readonly context: FilePreviewContext;
  readonly source: PreviewReadSource;
  readonly onReady?: () => void;
  readonly onDecodeError?: () => void;
  readonly providers: readonly Pick<PluginFilePreview, "id" | "name" | "renderer">[];
}
export function createPreviewOwners() {
  let current: PreviewOwner | null = null;
  let slot: object | null = null;
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const listener of listeners) listener();
  };
  return Object.freeze({
    snapshot: () => current,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    mount() {
      if (slot) throw new Error("plugin.filePreview.changed");
      const identity = {};
      slot = identity;
      return Object.freeze({
        publish(owner: PreviewOwner) {
          if (slot !== identity) return;
          owner.context.validateTarget();
          current = Object.freeze({ ...owner });
          changed();
        },
        dispose() {
          if (slot !== identity) return;
          slot = null;
          current = null;
          changed();
        },
      });
    },
  });
}
export const previewOwners = createPreviewOwners();
