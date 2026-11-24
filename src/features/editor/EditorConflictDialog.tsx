import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Dialog } from "@/components/ui/overlay/Dialog";
import { Button } from "@/components/ui/form/Button";
import { api } from "@/lib/api/ipc";
import { presentError } from "@/lib/api/errors";
import { editorDocument, useEditors, type EditorDiskVersion } from "@/store/editors";
import type { TextEncoding } from "@/lib/api/types";

function captureReview(tabId: string) {
  const document = editorDocument(tabId);
  const entry = useEditors.getState().entries[tabId];
  if (!document || !entry) return null;
  return {
    document,
    sessionId: entry.sessionId,
    sourceEncoding: entry.baselineEncoding ?? entry.encoding,
    encoding: entry.encoding,
    bom: entry.bom,
  };
}

export function EditorConflictDialog({ tabId, onClose }: { tabId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const [review, setReview] = useState(() => captureReview(tabId));
  const document = review?.document;
  const entry = useEditors((state) => state.entries[tabId]);
  const [disk, setDisk] = useState<EditorDiskVersion | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const stale =
    !document ||
    !entry ||
    entry.loading ||
    entry.disconnected ||
    entry.documentId !== document.documentId ||
    entry.version !== document.version ||
    entry.encoding !== review.encoding ||
    entry.bom !== review.bom;
  const refresh = () => {
    setDisk(null);
    setError(null);
    setReview(captureReview(tabId));
  };
  useEffect(() => {
    if (!review) return;
    let cancelled = false;
    const read =
      review.sessionId === null
        ? api.localReadText(review.document.path, review.sourceEncoding)
        : api.sftpReadText(review.sessionId, review.document.path, review.sourceEncoding);
    void read
      .then((file) => {
        if (!cancelled) {
          setDisk({
            content: file.content,
            encoding: (file.encoding ?? "utf-8") as TextEncoding,
            bom: file.bom ?? false,
          });
        }
      })
      .catch((error) => {
        if (!cancelled) setError(presentError(error));
      });
    return () => {
      cancelled = true;
    };
  }, [review]);

  const resolve = async (action: "reload" | "replace") => {
    if (!document || disk === null || busy || error || stale) return;
    setBusy(true);
    try {
      if (await useEditors.getState().resolveConflict(document, disk, action)) onClose();
      else setError(t("editor.reviewRetry"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title={t("editor.reviewTitle")}
      closeLabel={t("common.close")}
      onClose={onClose}
      width={880}
      className="editor-review"
      dismissible={!busy}
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            {t("editor.keepEditing")}
          </Button>
          <Button
            variant="secondary"
            disabled={busy || disk === null || !!error || stale}
            onClick={() => void resolve("reload")}
          >
            {t("editor.reloadDisk")}
          </Button>
          <Button
            variant="danger"
            disabled={busy || disk === null || !!error || stale}
            onClick={() => void resolve("replace")}
          >
            {t("editor.replaceDisk")}
          </Button>
        </>
      }
    >
      <p>{t("editor.reviewDescription")}</p>
      {error || stale ? (
        <div>
          <p role="alert">{error ?? t("editor.reviewStale")}</p>
          <Button
            size="sm"
            leading={<RefreshCw size={13} />}
            disabled={busy || !entry || entry.loading || entry.disconnected || entry.saving}
            onClick={refresh}
          >
            {t("editor.refreshComparison")}
          </Button>
        </div>
      ) : null}
      <div className="editor-review__columns">
        <label>
          {t("editor.diskVersion")}
          {disk ? <span className="editor-review__encoding">{disk.encoding}</span> : null}
          <textarea
            className="td-code-editor"
            readOnly
            value={disk?.content ?? ""}
            aria-busy={disk === null && !error && !stale}
            wrap="off"
          />
        </label>
        <label>
          {t("editor.yourDraft")}
          <span className="editor-review__encoding">{review?.encoding ?? "utf-8"}</span>
          <textarea
            className="td-code-editor"
            readOnly
            value={document?.content ?? ""}
            wrap="off"
          />
        </label>
      </div>
    </Dialog>
  );
}
