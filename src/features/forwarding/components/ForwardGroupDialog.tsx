import { useId, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/form/Button";
import { Field, Input } from "@/components/ui/form/Field";
import { Dialog } from "@/components/ui/overlay/Dialog";
import { translateError } from "@/lib/api/errors";
import { forwardingStore } from "../data/store";
import type { ForwardGroup } from "../model/contract";

export function ForwardGroupDialog({
  group,
  hostId,
  onClose,
}: {
  group?: ForwardGroup;
  hostId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const nameId = useId();
  const [draft, setDraft] = useState({ group, name: group?.name ?? "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (operation: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await operation();
      onClose();
    } catch (cause) {
      setError(translateError(cause));
    } finally {
      setBusy(false);
      forwardingStore.refresh();
    }
  };
  return (
    <Dialog
      open
      title={t(draft.group ? "forward.renameGroup" : "forward.addGroup")}
      closeLabel={t("common.close")}
      onClose={onClose}
      dismissible={!busy}
      width={400}
      footer={
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            disabled={busy || !draft.name.trim()}
            onClick={() =>
              void run(() =>
                invoke("forwarding_group_save", {
                  hostId,
                  name: draft.name,
                  ...(draft.group
                    ? { id: draft.group.id, expectedRevision: draft.group.revision }
                    : {}),
                }),
              )
            }
          >
            {t("common.save")}
          </Button>
        </>
      }
    >
      <Field label={t("forward.groupName")} htmlFor={nameId}>
        <Input
          id={nameId}
          autoFocus
          maxLength={80}
          disabled={busy}
          value={draft.name}
          onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.nativeEvent.isComposing &&
              event.nativeEvent.keyCode !== 229 &&
              draft.name.trim()
            ) {
              event.preventDefault();
              void run(() =>
                invoke("forwarding_group_save", {
                  hostId,
                  name: draft.name,
                  ...(draft.group
                    ? { id: draft.group.id, expectedRevision: draft.group.revision }
                    : {}),
                }),
              );
            }
          }}
        />
      </Field>
      {error && (
        <p className="td-field__error" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}
