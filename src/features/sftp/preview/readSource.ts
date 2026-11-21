import type { FilePreviewInfo, FilePreviewRenderer, PluginFilePreview } from "@/lib/api/types";
import { createProviderPreviewResource } from "@/lib/files/resources/preview";
import { createFileReadResource, readFileText } from "@/lib/files/resources/read";
import { captureFileTarget } from "@/lib/files/resources/target";
import type { PreviewFile } from "@/store/filePreview";

export interface PreviewReadValue {
  /** Host-only native ticket; never part of the public plugin preview context. */
  readonly info?: Readonly<FilePreviewInfo>;
  readonly content?: string | null;
  readonly encoding?: string;
}
export type PreviewReadSnapshot =
  | { readonly status: "loading" | "unavailable" }
  | { readonly status: "ready"; readonly value: Readonly<PreviewReadValue> }
  | { readonly status: "error"; readonly stage: "read" | "decode"; readonly cause: unknown };

/** A coordinator-owned read, not a renderer-owned effect. Removing a body or
 * staging another view must not close the file/ticket or start a second read. */
export function createPreviewReadSource(
  file: PreviewFile,
  renderer: FilePreviewRenderer,
  provider?: Pick<PluginFilePreview, "id" | "renderer">,
) {
  const target = captureFileTarget(file.path, file.source);
  const selected = provider && Object.freeze({ id: provider.id, renderer: provider.renderer });
  const available = !!selected || renderer === "text" || renderer === "markdown";
  let snapshot: PreviewReadSnapshot = Object.freeze({
    status: available ? "loading" : "unavailable",
  });
  const listeners = new Set<() => void>();
  let owners = 0;
  let active: { dispose(): void } | undefined;
  const publish = (next: PreviewReadSnapshot) => {
    snapshot = Object.freeze(next);
    for (const listener of listeners) listener();
  };
  return Object.freeze({
    snapshot: () => snapshot,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** Only resource owners retain. Display subscribers do not acquire I/O. */
    retain() {
      let released = false;
      if (++owners === 1 && available) {
        publish({ status: "loading" });
        const resource = selected
          ? createProviderPreviewResource(target.path, target.source, selected)
          : (() => {
              const read = createFileReadResource(target.path, target.source);
              return {
                ready: readFileText(read, "preview"),
                dispose: read.scope.dispose,
              };
            })();
        active = resource;
        void resource.ready.then(
          (result) => {
            if (active !== resource || snapshot.status === "error") return;
            publish({
              status: "ready",
              value: Object.freeze({
                content: result.content,
                encoding: result.encoding ?? "utf-8",
                ...("info" in result && result.info
                  ? { info: Object.freeze({ ...result.info }) }
                  : {}),
              }),
            });
          },
          (cause) => {
            if (active !== resource || snapshot.status === "error") return;
            resource.dispose();
            publish({ status: "error", stage: "read", cause });
          },
        );
      }
      return () => {
        if (released) return;
        released = true;
        if (--owners) return;
        const resource = active;
        active = undefined;
        resource?.dispose();
      };
    },
    /** Decode failures retire this attempt's own resource, never a replacement. */
    fail(cause: unknown) {
      if (!owners || !active || snapshot.status === "error") return;
      active.dispose();
      publish({ status: "error", stage: "decode", cause });
    },
  });
}
export type PreviewReadSource = ReturnType<typeof createPreviewReadSource>;
