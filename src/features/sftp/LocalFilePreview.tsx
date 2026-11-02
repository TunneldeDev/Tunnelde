import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog } from "@/components/ui/overlay/Dialog";
import { api } from "@/lib/api/ipc";
import { translateError } from "@/lib/api/errors";
import { useFilePreview } from "@/store/filePreview";

export function LocalFilePreview() {
  const file = useFilePreview((state) => state.file);
  return file ? <Preview key={file.path} file={file} /> : null;
}
function Preview({ file }: { file: { path: string; line: number; column: number } }) {
  const { t } = useTranslation();
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState("");
  const textarea = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    let disposed = false;
    void api
      .searchPreviewLocal(file.path)
      .then((text) => {
        if (!disposed) setContent(text);
      })
      .catch((cause) => {
        if (!disposed) setError(translateError(cause));
      });
    return () => {
      disposed = true;
    };
  }, [file.path]);
  useEffect(() => {
    if (content === null || !textarea.current) return;
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
  }, [content, file]);
  return (
    <Dialog
      open
      title={t("palette.localPreview")}
      closeLabel={t("common.close")}
      onClose={useFilePreview.getState().close}
      width={820}
    >
      <p className="settings-hint" style={{ overflowWrap: "anywhere" }}>
        {file.path}
      </p>
      {error ? (
        <p role="alert">{error}</p>
      ) : content === null ? (
        <p role="status">{t("common.loading")}</p>
      ) : (
        <textarea
          className="td-input td-textarea"
          ref={textarea}
          readOnly
          aria-label={t("palette.localPreview")}
          value={content}
          spellCheck={false}
          wrap="off"
          style={{
            minHeight: 280,
            height: "55vh",
            width: "100%",
            fontFamily: "var(--td-mono)",
            lineHeight: "20px",
            resize: "vertical",
          }}
        />
      )}
    </Dialog>
  );
}
