import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog } from "@/components/ui/overlay/Dialog";
import { Button } from "@/components/ui/form/Button";
import { FileTypeIcon } from "@/components/ui/display/FileTypeIcon";
import { useFileIconResolver } from "@/lib/files/icons";
import { PluginMarkdown } from "@/features/plugins/PluginMarkdown";
import { api } from "@/lib/api/ipc";
import { translateError } from "@/lib/api/errors";
import { useFilePreview, type PreviewFile } from "@/store/filePreview";
import { fileName } from "@/store/editors";
import { useSsh } from "@/store/ssh";
import { useWorkspace } from "@/store/workspace";
import { toast } from "@/store/toasts";

export function FilePreview() {
  const file = useFilePreview((state) => state.file);
  return file ? (
    <Preview
      key={`${file.source.kind === "remote" ? file.source.sessionId : "local"}:${file.path}`}
      file={file}
    />
  ) : null;
}
function Preview({ file }: { file: PreviewFile }) {
  const { t } = useTranslation();
  const resolveFileIcon = useFileIconResolver();
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState("");
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [renderMarkdown, setRenderMarkdown] = useState(
    file.line === 0 && /\.(md|markdown)$/i.test(file.path),
  );
  const session = useSsh((state) =>
    state.sessions.find(
      (session) => file.source.kind === "remote" && session.id === file.source.sessionId,
    ),
  );
  useEffect(() => {
    let disposed = false;
    const request =
      file.source.kind === "local"
        ? api.searchPreviewLocal(file.path)
        : api.sftpReadText(file.source.sessionId, file.path).then((file) => file.content);
    void request
      .then((text) => {
        if (!disposed) setContent(text);
      })
      .catch((cause) => {
        if (!disposed) setError(translateError(cause));
      });
    return () => {
      disposed = true;
    };
  }, [file.path, file.source]);
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
  }, [content, file, renderMarkdown]);
  return (
    <Dialog
      open
      title={`${t("sftp.preview")} · ${fileName(file.path)}`}
      closeLabel={t("common.close")}
      onClose={useFilePreview.getState().close}
      width={820}
      className="file-preview"
      footer={
        <>
          {content !== null && /\.(md|markdown)$/i.test(file.path) ? (
            <Button variant="secondary" onClick={() => setRenderMarkdown((value) => !value)}>
              {t(renderMarkdown ? "sftp.previewSource" : "sftp.previewRendered")}
            </Button>
          ) : null}
          <Button
            variant="secondary"
            disabled={file.source.kind === "remote" && !session}
            onClick={() => {
              if (file.source.kind === "local") {
                void api
                  .openLocalPath(file.path)
                  .catch((cause) => toast(translateError(cause), "error"));
              } else if (session) {
                useWorkspace.getState().openEditor(session, file.path);
                useFilePreview.getState().close();
              }
            }}
          >
            {t(file.source.kind === "local" ? "sftp.openWith" : "sftp.edit")}
          </Button>
        </>
      }
    >
      <p
        className="settings-hint"
        style={{ overflowWrap: "anywhere", display: "flex", gap: 8, alignItems: "center" }}
      >
        <FileTypeIcon icon={resolveFileIcon(file.path)} />
        <span>{file.path}</span>
      </p>
      {error ? (
        <p role="alert">{error}</p>
      ) : content === null ? (
        <p role="status">{t("common.loading")}</p>
      ) : renderMarkdown ? (
        <div className="file-preview__markdown">
          <PluginMarkdown source={content} />
        </div>
      ) : (
        <textarea
          className="td-input td-textarea"
          ref={textarea}
          readOnly
          aria-label={t("sftp.preview")}
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
