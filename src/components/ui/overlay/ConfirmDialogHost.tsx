import { useDialogs } from "@/store/dialogs";
import { ConfirmDialog } from "./ConfirmDialog";

/** Confirmation-only host is safe in resource-free satellite documents. */
export function ConfirmDialogHost() {
  const dialog = useDialogs((state) => state.dialog);
  if (dialog.kind !== "confirm") return null;
  return (
    <ConfirmDialog
      title={dialog.title}
      body={dialog.body}
      confirmLabel={dialog.confirmLabel}
      danger={dialog.danger}
      preformatted={dialog.preformatted}
      onConfirm={dialog.onConfirm}
      onClose={() => {
        const current = useDialogs.getState().dialog;
        if (current.kind === "confirm" && current.onConfirm === dialog.onConfirm)
          useDialogs.getState().close();
      }}
    />
  );
}
