import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/form/Button";
import type { FilePreviewInfo, PluginFilePreview } from "@/lib/api/types";
import { translateError } from "@/lib/api/errors";
import { createProviderPreviewResource } from "@/lib/files/resources/preview";
import type { PreviewFile } from "@/store/filePreview";
import { fileName } from "@/store/editors";
import { MediaPreview } from "./MediaPreview";
import { TextContent } from "./TextPreview";

const PdfPreview = lazy(() => import("./PdfPreview"));

export function ProviderPreview({
  file,
  provider,
  onReady,
  onReadError,
  onDecodeError,
  onRetry,
}: {
  file: PreviewFile;
  provider: PluginFilePreview;
  onReady: () => void;
  onReadError: () => void;
  onDecodeError: () => void;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  const [view, setView] = useState<{
    file: PreviewFile;
    providerId: string;
    renderer: PluginFilePreview["renderer"];
    resource: ReturnType<typeof createProviderPreviewResource>;
    info?: FilePreviewInfo;
    content?: string | null;
    failure?: { cause: unknown };
  } | null>(null);
  useEffect(() => {
    const resource = createProviderPreviewResource(file.path, file.source, {
      id: provider.id,
      renderer: provider.renderer,
    });
    const request = {
      file,
      providerId: provider.id,
      renderer: provider.renderer,
      resource,
    };
    let active = true;
    void resource.ready.then(
      (result) => {
        if (active) {
          setView({ ...request, ...result });
          if (provider.renderer === "text" || provider.renderer === "markdown") onReady();
        }
      },
      (cause) => {
        if (active) {
          setView({ ...request, failure: { cause } });
          onReadError();
        }
      },
    );
    return () => {
      active = false;
      resource.dispose();
    };
  }, [file, provider.id, provider.renderer, onReady, onReadError]);
  const current =
    view?.file === file && view.providerId === provider.id && view.renderer === provider.renderer
      ? view
      : null;
  const { info, content, failure } = current ?? {};
  const fail = useCallback(
    (cause: unknown) => {
      current?.resource.dispose();
      onDecodeError();
      setView((value) => (value && value === current ? { ...value, failure: { cause } } : value));
    },
    [current, onDecodeError],
  );
  if (failure)
    return (
      <div className="file-preview__empty">
        <p role="alert">{translateError(failure.cause)}</p>
        <Button variant="secondary" onClick={onRetry}>
          {t("common.retry")}
        </Button>
      </div>
    );
  if (!info) return <p role="status">{t("common.loading")}</p>;
  const url = convertFileSrc(info.id, "preview");
  if (info.renderer === "text" || info.renderer === "markdown")
    return content != null ? (
      <TextContent file={file} content={content} markdown={info.renderer === "markdown"} />
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
