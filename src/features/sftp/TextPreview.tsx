import { usePreviewSyntaxSource } from "./preview/previewSyntax";
import { useEffect } from "react";
import type { PreviewReadSource } from "./preview/readSource";
import { usePreviewReadSource } from "./preview/usePreviewReadSource";
import { PreviewRenderer } from "./preview/PreviewRenderer";
import { previewRenderRead } from "./preview/renderRead";
import type { PreviewFile } from "@/store/filePreview";

export function TextPreview({
  file,
  source,
  onReady,
  onError,
}: {
  file: PreviewFile;
  source: PreviewReadSource;
  onReady?: () => void;
  onError?: () => void;
}) {
  const syntax = usePreviewSyntaxSource(file, source);
  const result = usePreviewReadSource(source);
  useEffect(() => {
    if (result.status === "error") onError?.();
  }, [result, onError]);
  return (
    <PreviewRenderer
      file={file}
      syntax={syntax}
      renderer={/\.(md|markdown)$/i.test(file.path) ? "markdown" : "text"}
      read={previewRenderRead(result)}
      onReady={onReady}
    />
  );
}

export { TextContent } from "./preview/TextContent";
