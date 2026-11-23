import { useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/form/Button";
import {
  getLocalDiagnostics,
  reportError,
  subscribeLocalDiagnostics,
  type DiagnosticEvent,
} from "@/lib/diagnostics";

export function DiagnosticNotice({
  event,
  retry,
  clear,
}: {
  event: DiagnosticEvent | null;
  retry?: () => void;
  clear?: () => void;
}) {
  const { t } = useTranslation();
  const local = useSyncExternalStore(subscribeLocalDiagnostics, getLocalDiagnostics);
  const [showDetails, setShowDetails] = useState(false);
  const delivery = event && local.find((row) => row.event.eventId === event.eventId)?.delivery;
  return (
    <div className="diagnostic-notice" role="alert">
      <p>{t("diagnostic.failure")}</p>
      {event && <p>{t("diagnostic.reference", { id: event.eventId })}</p>}
      {delivery === "memory" && <p>{t("diagnostic.memoryOnly")}</p>}
      {retry && (
        <Button onClick={retry} size="sm">
          {t("common.retry")}
        </Button>
      )}
      {clear && (
        <Button onClick={clear} size="sm" variant="ghost">
          {t("settings.clearFilters")}
        </Button>
      )}
      {event && (
        <>
          <Button
            size="sm"
            variant="ghost"
            aria-expanded={showDetails}
            onClick={() => setShowDetails(!showDetails)}
          >
            {t("common.details")}
          </Button>
          {showDetails && (
            <>
              <pre>{JSON.stringify(event, null, 2)}</pre>
              <CopyDiagnosticDetails event={event} />
            </>
          )}
        </>
      )}
    </div>
  );
}

export function CopyDiagnosticDetails({ event }: { event: DiagnosticEvent }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  const copy = async () => {
    try {
      if (!navigator.clipboard) throw new Error("diagnostics.clipboardUnavailable");
      await navigator.clipboard.writeText(JSON.stringify(event, null, 2));
      setStatus("copied");
    } catch (error) {
      reportError("diagnostics", "copyDetails", error);
      setStatus("failed");
    }
  };
  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => void copy()}>
        {status === "copied" ? t("diagnostic.copied") : t("diagnostic.copyDetails")}
      </Button>
      {status === "failed" && <span role="status">{t("diagnostic.copyFailed")}</span>}
    </>
  );
}
