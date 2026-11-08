import { lazy, Suspense, useEffect, useState } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/form/Button";
import { api } from "@/lib/api/ipc";
import type { FilePreviewInfo, PluginFilePreview } from "@/lib/api/types";
import { translateError } from "@/lib/api/errors";
import { readPreviewRange } from "@/lib/files/preview";
import type { PreviewFile } from "@/store/filePreview";
import { fileName } from "@/store/editors";
import { MediaPreview } from "./MediaPreview";
import { TextContent } from "./TextPreview";

const PdfPreview = lazy(() => import("./PdfPreview"));

export function ProviderPreview({
  file,
  provider,
}: {
  file: PreviewFile;
  provider: PluginFilePreview;
}) {
  const { t } = useTranslation();
  const [info, setInfo] = useState<FilePreviewInfo | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [failure, setFailure] = useState<{ cause: unknown } | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    const id = crypto.randomUUID();
    const close = () => {
      void api.filePreviewClose(id).catch(() => {});
    };
    void api
      .filePreviewOpen(
        id,
        provider.id,
        file.path,
        file.source.kind === "remote" ? file.source.sessionId : null,
      )
      .then(async (result) => {
        if (controller.signal.aborted) {
          close();
          return;
        }
        if (result.renderer === "text" || result.renderer === "markdown") {
          const url = convertFileSrc(id, "preview");
          const chunks: Uint8Array[] = [];
          for (let start = 0; start < result.size; start += 1024 * 1024) {
            chunks.push(
              await readPreviewRange(
                url,
                start,
                Math.min(start + 1024 * 1024, result.size),
                controller.signal,
              ),
            );
          }
          const bytes = new Uint8Array(result.size);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
          }
          const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          if (text.includes("\0"))
            throw Object.assign(new Error("sftp.binaryFile"), { code: "validation" });
          if (controller.signal.aborted) return;
          setContent(text);
        }
        if (!controller.signal.aborted) setInfo(result);
      })
      .catch((cause) => {
        if (!controller.signal.aborted) setFailure({ cause });
      });
    return () => {
      controller.abort();
      close();
    };
  }, [file, provider.id, attempt]);
  if (failure)
    return (
      <div className="file-preview__empty">
        <p role="alert">{translateError(failure.cause)}</p>
        <Button
          variant="secondary"
          onClick={() => {
            setFailure(null);
            setInfo(null);
            setContent(null);
            setAttempt((value) => value + 1);
          }}
        >
          {t("common.retry")}
        </Button>
      </div>
    );
  if (!info) return <p role="status">{t("common.loading")}</p>;
  const url = convertFileSrc(info.id, "preview");
  if (info.renderer === "text" || info.renderer === "markdown")
    return content !== null ? (
      <TextContent file={file} content={content} markdown={info.renderer === "markdown"} />
    ) : null;
  if (info.renderer === "pdf")
    return (
      <Suspense fallback={<p role="status">{t("common.loading")}</p>}>
        <PdfPreview url={url} size={info.size} />
      </Suspense>
    );
  return (
    <MediaPreview
      kind={info.renderer}
      url={url}
      name={fileName(file.path)}
      onError={() => setFailure({ cause: { code: "validation", message: "preview.mediaError" } })}
    />
  );
}
