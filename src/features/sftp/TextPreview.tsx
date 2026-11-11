import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/form/Button";
import { PluginMarkdown } from "@/features/plugins/PluginMarkdown";
import { createFileReadResource, readFileText } from "@/lib/files/resources/read";
import { translateError } from "@/lib/api/errors";
import type { PreviewFile } from "@/store/filePreview";

export function TextPreview({ file }: { file: PreviewFile }) {
  const { t } = useTranslation();
  const [result, setResult] = useState<{
    file: PreviewFile;
    content?: string;
    cause?: unknown;
  } | null>(null);
  useEffect(() => {
    const resource = createFileReadResource(file.path, file.source);
    void readFileText(resource, "preview").then(
      (content) => {
        if (!resource.scope.signal.aborted) setResult({ file, content });
      },
      (cause) => {
        if (!resource.scope.signal.aborted) setResult({ file, cause });
      },
    );
    return resource.scope.dispose;
  }, [file]);
  const content = result?.file === file ? result.content : undefined;
  const error = result?.file === file && "cause" in result ? translateError(result.cause) : "";
  return error ? (
    <p role="alert">{error}</p>
  ) : content === undefined ? (
    <p role="status">{t("common.loading")}</p>
  ) : (
    <TextContent file={file} content={content} markdown={/\.(md|markdown)$/i.test(file.path)} />
  );
}

export function TextContent({
  file,
  content,
  markdown,
}: {
  file: PreviewFile;
  content: string;
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
      {markdown ? (
        <div className="file-preview__toolbar">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setRenderMarkdown((value) => !value)}
          >
            {t(renderMarkdown ? "sftp.previewSource" : "sftp.previewRendered")}
          </Button>
        </div>
      ) : null}
      {renderMarkdown ? (
        <div className="file-preview__markdown">
          <PluginMarkdown source={content} />
        </div>
      ) : (
        <textarea
          className="td-input td-textarea file-preview__text"
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
