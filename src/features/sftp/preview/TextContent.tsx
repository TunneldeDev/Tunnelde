import { useLayoutEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { usePanelViewState } from "@/lib/panels/viewState";
import { Button } from "@/components/ui/form/Button";
import { PluginMarkdown } from "@/features/plugins/PluginMarkdown";
import type { PreviewFile } from "@/store/filePreview";

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
  const [renderMarkdown, setRenderMarkdown] = usePanelViewState(
    "text.markdown",
    file.line === 0 && markdown,
    (value): value is boolean => typeof value === "boolean",
  );
  useLayoutEffect(() => {
    if (!textarea.current) return;
    const lines = content.split("\n");
    const line = Math.max(0, Math.min(lines.length - 1, file.line - 1));
    const offset =
      lines.slice(0, line).reduce((total, item) => total + item.length + 1, 0) +
      Array.from(lines[line] ?? "")
        .slice(0, Math.max(0, file.column - 1))
        .join("").length;
    if (!textarea.current.closest("[inert]")) textarea.current.focus();
    textarea.current.setSelectionRange(offset, offset);
    textarea.current.scrollTop = Math.max(0, line * 20 - 100);
  }, [content, file.path, file.line, file.column, renderMarkdown]);
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
        <div className="file-preview__markdown" data-panel-scroll="preview.markdown">
          <PluginMarkdown source={content} />
        </div>
      ) : (
        <textarea
          className="td-input td-textarea td-code-editor file-preview__text"
          ref={textarea}
          data-panel-scroll="preview.text"
          data-panel-focus="preview.text"
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
