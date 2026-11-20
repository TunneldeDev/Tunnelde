import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { FilePreviewRenderer, PluginFilePreview } from "@/lib/api/types";
import type { PreviewFile } from "@/store/filePreview";
import { createPreviewReadSource, type PreviewReadSource } from "./readSource";

/** Lives above movable renderer bodies. A retry/target/provider is a new owner;
 * presentation, language, visibility and display mounts are not. */
export function usePreviewReadOwner(
  file: PreviewFile,
  renderer: FilePreviewRenderer,
  attemptId: string,
  provider?: Pick<PluginFilePreview, "id" | "renderer">,
) {
  const providerId = provider?.id;
  const source = useMemo(
    () =>
      createPreviewReadSource(
        file,
        renderer,
        providerId ? { id: providerId, renderer } : undefined,
      ),
    // A fresh attempt deliberately reloads an otherwise identical target.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [file, renderer, providerId, attemptId],
  );
  useEffect(() => source.retain(), [source]);
  return source;
}

export function usePreviewReadSource(source: PreviewReadSource) {
  return useSyncExternalStore(source.subscribe, source.snapshot);
}
