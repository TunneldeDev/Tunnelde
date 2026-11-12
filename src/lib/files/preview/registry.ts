import type { FilePreviewContext } from "@/lib/extensions/files/preview/context";

type Registration = { readonly id: string; context: FilePreviewContext | null };
let current: Registration | null = null;
let revision = crypto.randomUUID();
const changed = () => {
  revision = crypto.randomUUID();
};

/** The current quick-look owner publishes only after a React commit. */
export function mountFilePreview(id: string) {
  if (current) throw new Error("plugin.filePreview.changed");
  const slot: Registration = { id, context: null };
  current = slot;
  let disposed = false;
  return Object.freeze({
    publish(context: FilePreviewContext) {
      if (disposed || current !== slot) return;
      if (context.snapshot.id !== id) throw new Error("plugin.filePreview.invalid");
      context.validateTarget();
      const previous = slot.context;
      slot.context = context;
      if (previous?.snapshot !== context.snapshot) changed();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (current === slot) {
        current = null;
        changed();
      }
    },
  });
}

export function filePreviewObservation() {
  if (current?.context) {
    try {
      current.context.validateTarget();
    } catch {
      current.context = null;
      changed();
    }
  }
  return { revision, preview: current?.context ?? null };
}
export function liveFilePreview(id: string, expected: string): FilePreviewContext {
  const context = current?.context;
  if (!context || context.snapshot.id !== id || context.snapshot.revision !== expected)
    throw new Error("plugin.filePreview.changed");
  context.validate();
  return context;
}
