import { Pause, Play, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/form/Button";
import { EmptyState } from "@/components/ui/display/Misc";
import { useSsh } from "@/store/ssh";
import { useProcessManager } from "./processes/runtime/useManager";
import { ProcessEntries } from "./processes/components/ProcessEntries";
import { ProcessesSurface } from "./processes/components/ProcessesSurface";
import "./processes.css";

export function ProcessesPage({
  sessionId,
  active = true,
}: {
  sessionId: string;
  active?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const manager = useProcessManager(sessionId, active);
  const session = useSsh((state) => state.sessions.find((item) => item.id === sessionId));
  const { loading, updatedAt, paused, refresh, togglePaused } = manager;
  if (!session)
    return (
      <div className="page">
        <EmptyState title={t("sftp.noSession")} />
      </div>
    );
  return (
    <div className="process-page">
      <header className="process-page__head">
        <strong>
          {t("processes.title")} · {session.title}
        </strong>
        <span className="process-status" role="status">
          {loading ? t("processes.updating") : paused ? t("processes.paused") : t("processes.live")}
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
      </header>
      {manager.error ? (
        <p className="connect__error" role="alert">
          {manager.error}
        </p>
      ) : null}
      <ProcessesSurface manager={manager}>
        <ProcessEntries manager={manager} />
      </ProcessesSurface>
    </div>
  );
}
