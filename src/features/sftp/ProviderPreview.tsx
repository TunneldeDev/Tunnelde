import { lazy, Suspense, useCallback, useEffect } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/form/Button";
import type { PluginFilePreview } from "@/lib/api/types";
import { translateError } from "@/lib/api/errors";
import type { PreviewReadSource } from "./preview/readSource";
import { usePreviewReadSource } from "./preview/usePreviewReadSource";
import type { PreviewFile } from "@/store/filePreview";
import { fileName } from "@/store/editors";
import { MediaPreview } from "./MediaPreview";
import { TextContent } from "./TextPreview";

const PdfPreview = lazy(() => import("./PdfPreview"));

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
  onReady: () => void;
  onReadError: () => void;
  onDecodeError: () => void;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  const view = usePreviewReadSource(source);
  useEffect(() => {
    if (view.status === "error" && view.stage === "read") onReadError();
    else if (
      view.status === "ready" &&
      (provider.renderer === "text" || provider.renderer === "markdown")
    )
      onReady();
  }, [view, provider.renderer, onReady, onReadError]);
  const { info, content, encoding } = view.status === "ready" ? view.value : {};
  const fail = useCallback(
    (cause: unknown) => {
      source.fail(cause);
      onDecodeError();
    },
    [source, onDecodeError],
  );
  if (view.status === "error")
    return (
      <div className="file-preview__empty">
        <p role="alert">{translateError(view.cause)}</p>
        <Button variant="secondary" onClick={onRetry}>
          {t("common.retry")}
        </Button>
      </div>
    );
  if (!info) return <p role="status">{t("common.loading")}</p>;
  const url = convertFileSrc(info.id, "preview");
  if (info.renderer === "text" || info.renderer === "markdown")
    return content != null ? (
      <TextContent
        file={file}
        content={content}
        encoding={encoding}
        markdown={info.renderer === "markdown"}
      />
    ) : null;
  if (info.renderer === "pdf")
    return (
      <Suspense fallback={<p role="status">{t("common.loading")}</p>}>
        <PdfPreview url={url} size={info.size} onError={fail} onReady={onReady} />
      </Suspense>
    );
  return (
    <MediaPreview
      kind={info.renderer}
      url={url}
      name={fileName(file.path)}
      onError={() => fail({ code: "validation", message: "preview.mediaError" })}
      onReady={onReady}
    />
  );
}
