import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/form/Button";
import { PluginMarkdown } from "@/features/plugins/PluginMarkdown";
import { createFileReadResource, readFileText } from "@/lib/files/resources/read";
import { translateError } from "@/lib/api/errors";
import type { PreviewFile } from "@/store/filePreview";

export function TextPreview({
  file,
  onReady,
  onError,
}: {
  file: PreviewFile;
  onReady?: () => void;
  onError?: () => void;
}) {
  const { t } = useTranslation();
  const [result, setResult] = useState<{
    file: PreviewFile;
    fileData?: { content: string; encoding?: string };
    cause?: unknown;
  } | null>(null);
  useEffect(() => {
    const resource = createFileReadResource(file.path, file.source);
    void readFileText(resource, "preview").then(
      (fileData) => {
        if (!resource.scope.signal.aborted) {
          setResult({ file, fileData });
          onReady?.();
        }
      },
      (cause) => {
        if (!resource.scope.signal.aborted) {
          setResult({ file, cause });
          onError?.();
        }
      },
    );
    return resource.scope.dispose;
  }, [file, onReady, onError]);
  const fileData = result?.file === file ? result.fileData : undefined;
  const error = result?.file === file && "cause" in result ? translateError(result.cause) : "";
  return error ? (
    <p role="alert">{error}</p>
  ) : fileData === undefined ? (
    <p role="status">{t("common.loading")}</p>
  ) : (
    <TextContent
      file={file}
      content={fileData.content}
      encoding={fileData.encoding ?? "utf-8"}
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
