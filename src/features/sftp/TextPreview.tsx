import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/form/Button";
import { PluginMarkdown } from "@/features/plugins/PluginMarkdown";
import type { PreviewReadSource } from "./preview/readSource";
import { usePreviewReadSource } from "./preview/usePreviewReadSource";
import { translateError } from "@/lib/api/errors";
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
  const { t } = useTranslation();
  const result = usePreviewReadSource(source);
  useEffect(() => {
    if (result.status === "ready") onReady?.();
    else if (result.status === "error") onError?.();
  }, [result, onReady, onError]);
  return result.status === "error" ? (
    <p role="alert">{translateError(result.cause)}</p>
  ) : result.status !== "ready" || result.value.content == null ? (
    <p role="status">{t("common.loading")}</p>
  ) : (
    <TextContent
      file={file}
      content={result.value.content}
      encoding={result.value.encoding ?? "utf-8"}
      markdown={/\.(md|markdown)$/i.test(file.path)}
    />
  );
}

export function TextContent({
  file,
  content,
  encoding,
  markdown,
}: {
  file: PreviewFile;
  content: string;
  encoding?: string;
  markdown: boolean;
}) {
  const { t } = useTranslation();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [renderMarkdown, setRenderMarkdown] = useState(file.line === 0 && markdown);
  useEffect(() => {
    if (!textarea.current) return;
    const lines = content.split("\n");
    const line = Math.max(0, Math.min(lines.length - 1, file.line - 1));
    const offset =
      lines.slice(0, line).reduce((total, item) => total + item.length + 1, 0) +
      Array.from(lines[line] ?? "")
        .slice(0, Math.max(0, file.column - 1))
        .join("").length;
    textarea.current.focus();
    textarea.current.setSelectionRange(offset, offset);
    textarea.current.scrollTop = Math.max(0, line * 20 - 100);
  }, [content, file, renderMarkdown]);
  return (
    <>
      {markdown || encoding ? (
        <div className="file-preview__toolbar">
          {encoding ? <span className="file-preview__encoding">{encoding}</span> : null}
          {markdown ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setRenderMarkdown((value) => !value)}
            >
              {t(renderMarkdown ? "sftp.previewSource" : "sftp.previewRendered")}
            </Button>
          ) : null}
        </div>
      ) : null}
      {renderMarkdown ? (
        <div className="file-preview__markdown">
          <PluginMarkdown source={content} />
        </div>
      ) : (
        <textarea
          className="td-input td-textarea td-code-editor file-preview__text"
          ref={textarea}
          readOnly
          aria-label={t("sftp.preview")}
          value={content}
          spellCheck={false}
          wrap="off"
        />
      )}
    </>
  );
}
