import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog } from "@/components/ui/overlay/Dialog";
import { Button } from "@/components/ui/form/Button";
import { api } from "@/lib/api/ipc";
import { translateError } from "@/lib/api/errors";
import { editorDocument, useEditors } from "@/store/editors";

export function EditorConflictDialog({ tabId, onClose }: { tabId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const [document] = useState(() => editorDocument(tabId));
  const [disk, setDisk] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const entry = useEditors.getState().entries[tabId];
    if (!entry) return;
    let cancelled = false;
    const read =
      entry.sessionId === null
        ? api.localReadText(entry.path)
        : api.sftpReadText(entry.sessionId, entry.path);
    void read
      .then((file) => {
        if (!cancelled) setDisk(file.content);
      })
      .catch((error) => {
        if (!cancelled) setError(translateError(error));
      });
    return () => {
      cancelled = true;
    };
  }, [tabId]);

  const resolve = async (action: "reload" | "replace") => {
    if (!document || disk === null || busy) return;
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
            disabled={busy || disk === null}
            onClick={() => void resolve("reload")}
          >
            {t("editor.reloadDisk")}
          </Button>
          <Button
            variant="danger"
            disabled={busy || disk === null}
            onClick={() => void resolve("replace")}
          >
            {t("editor.replaceDisk")}
          </Button>
        </>
      }
    >
      <p>{t("editor.reviewDescription")}</p>
      {error ? <p role="alert">{error}</p> : null}
      <div className="editor-review__columns">
        <label>
          {t("editor.diskVersion")}
          <textarea readOnly value={disk ?? ""} aria-busy={disk === null} wrap="off" />
        </label>
        <label>
          {t("editor.yourDraft")}
          <textarea readOnly value={document?.content ?? ""} wrap="off" />
        </label>
      </div>
    </Dialog>
  );
}
