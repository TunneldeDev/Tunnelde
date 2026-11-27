import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/form/Button";
import { Field, Input, Textarea } from "@/components/ui/form/Field";
import { Dialog } from "@/components/ui/overlay/Dialog";
import { presentError } from "@/lib/api/errors";
import type { ProcessManager } from "../runtime/useManager";

export function RunTask({ manager }: { manager: ProcessManager }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [command, setCommand] = useState("");
  const [cwd, setCwd] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pid, setPid] = useState<number | null>(null);
  const submit = async () => {
    if (!command.trim() || busy) return;
    setBusy(true);
    setError(null);
    setPid(null);
    try {
      setPid(await manager.launch(command, cwd));
    } catch (cause) {
      setError(presentError(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button
        variant="ghost"
        leading={<Plus size={13} />}
        disabled={manager.stopping}
        onClick={() => {
          setOpen(true);
          setError(null);
          setPid(null);
        }}
      >
        {t("processes.runTask")}
      </Button>
      <Dialog
        open={open}
        title={t("processes.runTask")}
        closeLabel={t("common.close")}
        onClose={() => setOpen(false)}
        dismissible={!busy}
        footer={
          <>
            <Button variant="secondary" disabled={busy} onClick={() => setOpen(false)}>
              {t("common.close")}
            </Button>
            <Button
              disabled={busy || !command.trim()}
              onClick={() => {
                void submit();
              }}
            >
              {t("processes.run")}
            </Button>
          </>
        }
      >
        <Field label={t("processes.command")} htmlFor="process-command">
          <Textarea
            id="process-command"
            value={command}
            maxLength={16384}
            disabled={busy}
            onChange={(event) => setCommand(event.target.value)}
          />
        </Field>
        <Field label={t("processes.cwd")} htmlFor="process-cwd">
          <Input
            id="process-cwd"
            placeholder="/home/user"
            value={cwd}
            maxLength={4096}
            disabled={busy}
            onChange={(event) => setCwd(event.target.value)}
          />
        </Field>
        <p className="process-help">{t("processes.runHint")}</p>
        {error ? (
          <p className="connect__error" role="alert">
            {error}
          </p>
        ) : null}
        {pid !== null ? <p role="status">{t("processes.launched", { pid })}</p> : null}
      </Dialog>
    </>
  );
}
