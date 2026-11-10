import { Pause, Play, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/form/Button";
import { Dialog } from "@/components/ui/overlay/Dialog";
import { useProcessManager } from "./processes/runtime/useManager";
import { ProcessEntries } from "./processes/components/ProcessEntries";
import { ProcessesSurface } from "./processes/components/ProcessesSurface";
import "./processes.css";

export function ProcessesDialog({
  sessionId,
  onClose,
}: {
  sessionId: string;
  onClose: () => void;
}) {
  const { t, i18n } = useTranslation();
  const manager = useProcessManager(sessionId);
  const { loading, updatedAt, paused, refresh, togglePaused } = manager;
  const close = () => {
    manager.close();
    onClose();
  };
  return (
    <Dialog
      open
      title={t("processes.title")}
      closeLabel={t("common.close")}
      onClose={close}
      width={1160}
      className="process-dialog"
      footer={
        <>
          <span className="process-status" role="status">
            {loading
              ? t("processes.updating")
              : paused
                ? t("processes.paused")
                : t("processes.live")}
            {updatedAt ? ` · ${new Date(updatedAt).toLocaleTimeString(i18n.resolvedLanguage)}` : ""}
          </span>
          <Button
            variant="ghost"
            leading={paused ? <Play size={13} /> : <Pause size={13} />}
            onClick={togglePaused}
          >
            {t(paused ? "processes.resume" : "processes.pause")}
          </Button>
          <Button
            variant="ghost"
            disabled={loading}
            leading={<RefreshCw size={13} />}
            onClick={refresh}
          >
            {t("processes.refresh")}
          </Button>
          <Button variant="secondary" onClick={close}>
            {t("common.close")}
          </Button>
        </>
      }
    >
      {manager.error ? (
        <p className="connect__error" role="alert">
          {manager.error}
        </p>
      ) : null}
      <ProcessesSurface manager={manager}>
        <ProcessEntries manager={manager} />
      </ProcessesSurface>
    </Dialog>
  );
}
