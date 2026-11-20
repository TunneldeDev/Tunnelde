import type {
  FilePreviewMetadata,
  FilePreviewProviderEntry,
} from "@/lib/extensions/contracts/files/preview/data";
import i18n from "@/i18n/i18n";
import type { PreviewOwner } from "./owner";

/** Private read projection. Content is separate from the <=1MiB view capsule;
 * the native ticket is deliberately absent, including in errors/metadata. */
export interface PreviewWindowData {
  readonly snapshot: FilePreviewMetadata;
  readonly providers: readonly FilePreviewProviderEntry[];
  readonly read:
    | { readonly status: "loading" | "unavailable" }
    | { readonly status: "error"; readonly message: string; readonly stage: "read" | "decode" }
    | {
        readonly status: "ready";
        readonly content?: string | null;
        readonly encoding?: string;
        readonly resource?: {
          readonly id: string;
          readonly size: number;
          readonly renderer: FilePreviewMetadata["renderer"];
        };
      };
}
export function previewWindowData(owner: PreviewOwner): PreviewWindowData {
  owner.context.validateTarget();
  const read = owner.source.snapshot();
  return {
    snapshot: owner.context.snapshot,
    providers: owner.providers.map(({ id, name, renderer }) => ({ id, name, renderer })),
    read:
      read.status === "ready"
        ? {
            status: "ready",
            content: read.value.content,
            encoding: read.value.encoding,
            ...(read.value.info
              ? {
                  resource: {
                    id: owner.context.snapshot.attemptId,
                    size: read.value.info.size,
                    renderer: read.value.info.renderer,
                  },
                }
              : {}),
          }
        : read.status === "error"
          ? { status: "error", stage: read.stage, message: i18n.t("preview.mediaError") }
          : { status: read.status },
  };
}
