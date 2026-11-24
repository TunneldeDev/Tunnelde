import { lazy, Suspense, useCallback, useLayoutEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/form/Button";
import { usePanelReadiness } from "@/lib/panels/usePanelReadiness";
import type { FilePreviewRenderer } from "@/lib/api/types";
import type { PreviewFile } from "@/store/filePreview";
import { fileName } from "@/store/editors";
import { MediaPreview } from "../MediaPreview";
import type { PreviewSyntaxSource } from "./usePreviewSyntax";
import { TextContent } from "./TextContent";

const PdfPreview = lazy(() => import("../PdfPreview"));
export type PreviewRenderRead =
  | { readonly status: "loading" | "unavailable" }
  | { readonly status: "error"; readonly message: string }
  | {
      readonly status: "ready";
      readonly content?: string | null;
      readonly encoding?: string;
      readonly resource?: { readonly renderer: FilePreviewRenderer; readonly size: number };
    };
/** Pure display adapter shared by local reads and future scoped-window models.
 * No file store, resource acquisition/closure, invoke, or feature bootstrap. */
export function PreviewRenderer({
  file,
  renderer,
  read,
  url,
  onReady,
  onDecodeError,
  onRetry,
  active = true,
  syntax,
}: {
  file: PreviewFile;
  renderer: FilePreviewRenderer;
  read: PreviewRenderRead;
  url?: string;
  active?: boolean;
  syntax?: PreviewSyntaxSource;
  onReady?(): void;
  onDecodeError?(cause: unknown): void;
  onRetry?(): void;
}) {
  const { t } = useTranslation();
  const [decoded, setDecoded] = useState(false);
  const text = renderer === "text" || renderer === "markdown";
  const textReady = text && read.status === "ready" && typeof read.content === "string";
  const ready =
    read.status === "ready" && (textReady || (!text && decoded && !!url && !!read.resource));
  const cause =
    read.status === "error"
      ? new Error(read.message)
      : read.status === "unavailable"
        ? new Error("preview.providerUnavailable")
        : undefined;
  usePanelReadiness("preview.body", ready, cause);
  const decodedReady = useCallback(() => {
    setDecoded(true);
    onReady?.();
  }, [onReady]);
  useLayoutEffect(() => {
    if (textReady) onReady?.();
  }, [textReady, onReady]);
  if (read.status === "error")
    return (
      <div className="file-preview__empty">
        <p role="alert">{read.message}</p>
        {onRetry ? (
          <Button variant="secondary" onClick={onRetry}>
            {t("common.retry")}
          </Button>
        ) : null}
      </div>
    );
  if (read.status !== "ready") return <p role="status">{t("common.loading")}</p>;
  if (text)
    return typeof read.content === "string" ? (
      <TextContent
        file={file}
        active={active}
        syntax={syntax}
        content={read.content}
        encoding={read.encoding}
        markdown={renderer === "markdown"}
      />
    ) : (
      <p role="status">{t("common.loading")}</p>
    );
  if (!url || !read.resource) return <p role="status">{t("common.loading")}</p>;
  if (renderer === "pdf")
    return (
      <Suspense fallback={<p role="status">{t("common.loading")}</p>}>
        <PdfPreview
          url={url}
          size={read.resource.size}
          onError={onDecodeError}
          onReady={decodedReady}
        />
      </Suspense>
    );
  return (
    <MediaPreview
      active={active}
      kind={renderer}
      url={url}
      name={fileName(file.path)}
      onError={() => onDecodeError?.({ code: "validation", message: "preview.mediaError" })}
      onReady={decodedReady}
    />
  );
}
