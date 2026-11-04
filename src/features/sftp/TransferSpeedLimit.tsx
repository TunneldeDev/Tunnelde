import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/form/Button";
import { Input } from "@/components/ui/form/Field";
import { useTransfers } from "@/store/transfers";

export function TransferSpeedLimit({
  id,
  value,
  onClose,
}: {
  id: string;
  value: number;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const fieldId = useId();
  const [draft, setDraft] = useState(String(value));
  const [busy, setBusy] = useState(false);
  const [invalid, setInvalid] = useState(false);
  return (
    <form
      className="transfer__limit"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.nativeEvent.isComposing) {
          event.stopPropagation();
          onClose();
        }
      }}
      onSubmit={(event) => {
        event.preventDefault();
        const kib = Number(draft);
        if (!draft.trim() || !Number.isInteger(kib) || kib < 0 || kib > 1_048_576) {
          setInvalid(true);
          return;
        }
        setBusy(true);
        void useTransfers
          .getState()
          .setSpeedLimit(id, kib)
          .then((saved) => {
            setBusy(false);
            if (saved) onClose();
          });
      }}
    >
      <label htmlFor={fieldId}>{t("sftp.taskSpeedLimit")}</label>
      <div className="transfer__limit-controls">
        <Input
          id={fieldId}
          type="number"
          min={0}
          max={1_048_576}
          step={1}
          autoFocus
          value={draft}
          disabled={busy}
          aria-describedby={`${fieldId}-hint`}
          aria-invalid={invalid || undefined}
          onChange={(event) => {
            setDraft(event.target.value);
            setInvalid(false);
          }}
        />
        <span>KiB/s</span>
        <Button size="sm" type="submit" disabled={busy}>
          {t("common.apply")}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onClose}>
          {t("common.cancel")}
        </Button>
      </div>
      <small id={`${fieldId}-hint`}>{t("sftp.taskSpeedLimitHint")}</small>
      {invalid ? <span role="alert">{t("sftp.invalidSpeedLimit")}</span> : null}
    </form>
  );
}
