import { presentError } from "@/lib/api/errors";
import type { PreviewReadSnapshot } from "./readSource";
import type { PreviewRenderRead } from "./PreviewRenderer";

/** Local display data only. Never pass the source's native ticket to a provider
 * or model; cross-window projection separately sanitizes error details. */
export function previewRenderRead(read: PreviewReadSnapshot): PreviewRenderRead {
  return read.status === "ready"
    ? {
        status: "ready",
        content: read.value.content,
        encoding: read.value.encoding,
        ...(read.value.info
          ? { resource: { renderer: read.value.info.renderer, size: read.value.info.size } }
          : {}),
      }
    : read.status === "error"
      ? { status: "error", message: presentError(read.cause) }
      : { status: read.status };
}
