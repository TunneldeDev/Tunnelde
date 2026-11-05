import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { FileText, FolderOpen, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/form/Button";
import { Dialog } from "@/components/ui/overlay/Dialog";
import { api, isTauri, type LogSnapshot } from "@/lib/api/ipc";
import { translateError } from "@/lib/api/errors";
import { toast } from "@/store/toasts";
import "./logViewer.css";

export function LogViewer() {
  const { t, i18n } = useTranslation();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"operations" | "diagnostic">("operations");
  const [snapshot, setSnapshot] = useState<LogSnapshot | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!open) return;
    let active = true;
    void api
      .logsRead()
      .then((result) => {
        if (active) setSnapshot(result);
      })
      .catch((failure: unknown) => {
        if (active) setError(translateError(failure));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [open, revision]);
  return (
    <div className="settings-preference-group log-settings">
      <h3 className="settings-preference-group__title">{t("logs.title")}</h3>
      <div className="settings-preference-group__body log-settings__body">
        <p className="settings-row__hint">{t("logs.description")}</p>
        <Button
          size="sm"
          leading={<FileText size={14} />}
          disabled={!isTauri()}
          onClick={() => {
            setLoading(true);
            setError("");
            setOpen(true);
          }}
        >
          {t("logs.view")}
        </Button>
      </div>
      <Dialog
        open={open}
        title={t("logs.title")}
        closeLabel={t("common.close")}
        onClose={() => setOpen(false)}
        width={860}
        footer={
          <>
            <Button
              leading={<FolderOpen size={14} />}
              onClick={() =>
                void api.openLogDir().catch((failure) => toast(translateError(failure), "error"))
              }
            >
              {t("logs.openFolder")}
            </Button>
            <Button
              leading={<RefreshCw size={14} />}
              disabled={loading}
              onClick={() => {
                setLoading(true);
                setError("");
                setRevision((value) => value + 1);
              }}
            >
              {t("common.refresh")}
            </Button>
            <Button onClick={() => setOpen(false)}>{t("common.close")}</Button>
          </>
        }
      >
        <div className="log-viewer">
          <div className="log-viewer__tabs" role="tablist" aria-label={t("logs.title")}>
            {(["operations", "diagnostic"] as const).map((item) => (
              <button
                type="button"
                role="tab"
                key={item}
                aria-selected={tab === item}
                onClick={() => setTab(item)}
              >
                {t(`logs.${item}`)}
              </button>
            ))}
          </div>
          <p className="settings-row__hint">
            {t(tab === "operations" ? "logs.operationsHint" : "logs.diagnosticHint")}
          </p>
          {loading ? <p role="status">{t("common.loading")}</p> : null}
          {error ? (
            <p className="settings-message is-error" role="alert">
              {error}
            </p>
          ) : null}
          {!loading && !error && snapshot ? (
            tab === "operations" ? (
              <div className="log-viewer__content" role="tabpanel">
                {snapshot.operations.length ? (
                  snapshot.operations.map((entry) => (
                    <div className="log-viewer__row" key={entry.id}>
                      <time>{new Date(entry.timestamp).toLocaleString(i18n.language)}</time>
                      <span>{entry.action}</span>
                      <code>{entry.target}</code>
                    </div>
                  ))
                ) : (
                  <p>{t("logs.emptyOperations")}</p>
                )}
              </div>
            ) : (
              <div role="tabpanel">
                <p className="settings-row__hint">
                  {snapshot.filename ?? t("logs.emptyDiagnostic")}
                  {snapshot.truncated ? ` · ${t("logs.truncated")}` : ""}
                </p>
                <pre className="log-viewer__content log-viewer__raw">{snapshot.diagnostic}</pre>
              </div>
            )
          ) : null}
        </div>
      </Dialog>
    </div>
  );
}
