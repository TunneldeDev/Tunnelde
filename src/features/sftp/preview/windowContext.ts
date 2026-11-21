import type { FilePreviewContext } from "@/lib/extensions/files/preview/context";
import type { PreviewWindowData } from "./windowModel";
import type { PreviewCommand, PreviewWindowAction } from "./windowActions";

/** Display context from a bounded host projection, not a cloned feature store. */
export function createWindowPreviewContext(
  data: PreviewWindowData,
  validate: () => void,
  action: (request: PreviewWindowAction) => Promise<unknown>,
): FilePreviewContext {
  const snapshot = data.snapshot;
  const act = (command: PreviewCommand) => {
    validate();
    return action({
      kind: "preview",
      id: snapshot.id,
      attemptId: snapshot.attemptId,
      revision: snapshot.revision,
      command,
    });
  };
  return {
    snapshot,
    validate,
    validateTarget: validate,
    readProviders(request) {
      validate();
      if (request.revision !== snapshot.revision) throw new Error("plugin.filePreview.changed");
      const offset = request.offset ?? 0,
        limit = request.limit ?? 16;
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        offset > data.providers.length ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 32
      )
        throw new Error("plugin.filePreview.invalid");
      const items = Object.freeze(data.providers.slice(offset, offset + limit));
      const end = offset + items.length;
      return {
        schemaVersion: 1,
        id: snapshot.id,
        revision: snapshot.revision,
        total: data.providers.length,
        offset,
        nextOffset: end < data.providers.length ? end : null,
        items,
      };
    },
    close: () => act({ operation: "close" }),
    retry: () => act({ operation: "retry" }),
    dock: () => act({ operation: "dock" }),
    undock: () => act({ operation: "undock" }),
    selectProvider(providerId) {
      validate();
      if (!data.providers.some((p) => p.id === providerId))
        throw new Error("plugin.filePreview.invalid");
      return act({ operation: "selectProvider", providerId });
    },
  };
}
