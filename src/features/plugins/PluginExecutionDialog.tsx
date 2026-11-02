import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/form/Button";
import { Field, Input } from "@/components/ui/form/Field";
import { Dialog } from "@/components/ui/overlay/Dialog";
import { api } from "@/lib/api/ipc";
import { translateError } from "@/lib/api/errors";
import type { ChatExecution } from "@/lib/plugins/pluginChat";

export function PluginExecutionDialog({
  targetId,
  targetName,
  execution,
  apiAssistant,
  busy,
  error,
  onClose,
  onSave,
}: {
  targetId: string;
  targetName: string;
  execution?: ChatExecution | null;
  apiAssistant: boolean;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (input: Record<string, unknown>) => Promise<void>;
}) {
  const { t } = useTranslation();
  const id = useId();
  const [cwd, setCwd] = useState(execution?.cwd || "");
  const [executable, setExecutable] = useState(execution?.executable || "");
  const [runtime, setRuntime] = useState(execution?.runtime || "");
  const [picking, setPicking] = useState(false);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const remote = targetId !== "local";
  const pickFolder = async () => {
    setPicking(true);
    try {
      const value = await api.pluginPickFolder(t("pluginChat.cwd"));
      if (value) setCwd(value);
    } catch (cause) {
      setPickerError(translateError(cause));
    } finally {
      setPicking(false);
    }
  };
  return (
    <Dialog
      open
      title={`${t("pluginChat.executionSettings")} · ${targetName}`}
      closeLabel={t("common.close")}
      onClose={onClose}
      width={500}
      dismissible={!busy}
      footer={
        <>
          <Button disabled={busy} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            disabled={busy || picking}
            onClick={() => {
              void onSave({
                ...(cwd.trim() ? { cwd: cwd.trim() } : {}),
                ...(executable.trim() ? { executable: executable.trim() } : {}),
                ...(remote && apiAssistant ? { runtime: runtime.trim() } : {}),
              });
            }}
          >
            {t("pluginChat.useTarget")}
          </Button>
        </>
      }
    >
      <div className="plugin-chat-config__grid">
        <p>{t("pluginChat.targetHint")}</p>
        <Field htmlFor={`${id}-cwd`} label={t("pluginChat.cwd")} hint={t("pluginChat.cwdAutoHint")}>
          <Input
            id={`${id}-cwd`}
            disabled={busy || picking}
            value={cwd}
            placeholder="~"
            onChange={(event) => setCwd(event.target.value)}
          />
          {!remote ? (
            <Button
              disabled={busy || picking}
              onClick={() => {
                void pickFolder();
              }}
            >
              {t("pluginChat.browse")}
            </Button>
          ) : null}
        </Field>
        {!apiAssistant ? (
          <Field
            htmlFor={`${id}-executable`}
            label={t("pluginChat.executable")}
            hint={t("pluginChat.agentExecutableHint")}
          >
            <Input
              id={`${id}-executable`}
              disabled={busy}
              value={executable}
              onChange={(event) => setExecutable(event.target.value)}
            />
          </Field>
        ) : null}
        {remote && apiAssistant ? (
          <Field
            htmlFor={`${id}-runtime`}
            label={t("pluginChat.remoteNode")}
            hint={t("pluginChat.remoteNodeConsent")}
          >
            <Input
              id={`${id}-runtime`}
              placeholder={t("pluginChat.runtimeInstallHint")}
              disabled={busy}
              value={runtime}
              onChange={(event) => setRuntime(event.target.value)}
            />
          </Field>
        ) : null}
        {error || pickerError ? <p role="alert">{error || pickerError}</p> : null}
      </div>
    </Dialog>
  );
}
