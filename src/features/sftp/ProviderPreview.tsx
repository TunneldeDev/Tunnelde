import { useCallback, useEffect } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { PluginFilePreview } from "@/lib/api/types";
import type { PreviewReadSource } from "./preview/readSource";
import { usePreviewReadSource } from "./preview/usePreviewReadSource";
import { PreviewRenderer } from "./preview/PreviewRenderer";
import { previewRenderRead } from "./preview/renderRead";
import type { PreviewFile } from "@/store/filePreview";

export function ProviderPreview({
  file,
  provider,
  source,
  onReady,
  onReadError,
  onDecodeError,
  onRetry,
}: {
  file: PreviewFile;
  provider: PluginFilePreview;
  source: PreviewReadSource;
  onReady(): void;
  onReadError(): void;
  onDecodeError(): void;
  onRetry(): void;
}) {
  const view = usePreviewReadSource(source);
  useEffect(() => {
    if (view.status === "error" && view.stage === "read") onReadError();
  }, [view, onReadError]);
  const fail = useCallback(
    (cause: unknown) => {
      source.fail(cause);
      onDecodeError();
    },
    [source, onDecodeError],
  );
  const info = view.status === "ready" ? view.value.info : undefined;
  return (
    <PreviewRenderer
      file={file}
      renderer={provider.renderer}
      read={previewRenderRead(view)}
      url={info ? convertFileSrc(info.id, "preview") : undefined}
      onReady={onReady}
      onDecodeError={fail}
      onRetry={onRetry}
    />
  );
}
