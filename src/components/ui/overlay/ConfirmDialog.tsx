import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/form/Button";
import { Dialog } from "./Dialog";
import { presentError } from "@/lib/api/errors";
import { toast } from "@/store/toasts";

export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  danger,
  preformatted,
  focusCancel = false,
  onConfirm,
  onClose,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
  preformatted?: boolean;
  focusCancel?: boolean;
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);

  const run = async () => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    try {
      await onConfirm();
      onClose();
    } catch (cause) {
      toast(presentError(cause), "error");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      title={title}
      closeLabel={t("common.close")}
      onClose={onClose}
      width={preformatted ? 760 : 400}
      dismissible={!busy}
      footer={
        <>
          <Button variant="ghost" autoFocus={focusCancel} disabled={busy} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            variant={danger ? "danger" : "primary"}
            autoFocus={!focusCancel}
            disabled={busy}
            onClick={() => void run()}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      {preformatted ? (
        <pre
          className="dialog-text"
          tabIndex={0}
          style={{
            maxHeight: "55vh",
            overflow: "auto",
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
            fontFamily: "var(--td-mono)",
            fontSize: 12,
            lineHeight: 1.6,
          }}
        >
          {body}
        </pre>
      ) : (
        <p className="dialog-text">{body}</p>
      )}
    </Dialog>
  );
}
