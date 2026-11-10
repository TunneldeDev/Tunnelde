import { useEffect, useState } from "react";
import { ChevronRight, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/form/Button";
import { Select } from "@/components/ui/form/Select";
import { api } from "@/lib/api/ipc";
import { runnerRecoveryApi as client } from "@/lib/api/runners/recovery";
import { translateError } from "@/lib/api/errors";
import type { RecoveryOwners } from "@/lib/runners/recovery/contracts";
import { useRecoveryPage } from "../runtime/useRecoveryPage";
import { RecoveryRecord } from "./RecoveryRecord";
import "./recovery.css";

function RecoveryError({ message }: { message: string }) {
  const { t } = useTranslation();
  const [logError, setLogError] = useState<string | null>(null);
  return (
    <div className="settings-message is-error" role="alert">
      <p>{message}</p>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          void api.openLatestLog().catch((error) => setLogError(translateError(error)));
        }}
      >
        {t("runnerRecovery.openLog")}
      </Button>
      {logError && <p>{logError}</p>}
    </div>
  );
}

function RecoveryPage({
  pluginId,
  offset,
  setOffset,
}: {
  pluginId: string;
  offset: number;
  setOffset: (offset: number) => void;
}) {
  const { t } = useTranslation();
  const page = useRecoveryPage(pluginId, offset);
  return (
    <div aria-busy={page.pending}>
      <div className="runner-recovery__toolbar">
        <span className="settings-hint">
          {page.snapshot
            ? t("runnerRecovery.recordCount", { count: page.snapshot.total })
            : t("common.loading")}
        </span>
        <Button
          size="sm"
          disabled={page.pending}
          leading={<RefreshCw size={13} />}
          onClick={() => void page.reload()}
        >
          {t("common.refresh")}
        </Button>
      </div>
      {page.error && <RecoveryError message={page.error} />}
      {page.snapshot?.entries.length === 0 && (
        <p className="settings-hint">{t("runnerRecovery.empty")}</p>
      )}
      {page.snapshot?.entries.map((entry) => (
        <RecoveryRecord
          key={JSON.stringify([entry.runnerId, entry.hostId, entry.directory])}
          entry={entry}
          observation={page.observations[entry.token]}
          pending={page.pending}
          onAction={(action) => void page.act(entry, action)}
        />
      ))}
      {page.snapshot && (offset > 0 || page.snapshot.nextOffset !== null) && (
        <div className="runner-recovery__pagination">
          <Button
            size="sm"
            disabled={page.pending || offset === 0}
            onClick={() => setOffset(Math.max(0, offset - 32))}
          >
            {t("runnerRecovery.previous")}
          </Button>
          <span>{t("runnerRecovery.page", { page: Math.floor(offset / 32) + 1 })}</span>
          <Button
            size="sm"
            disabled={page.pending || page.snapshot.nextOffset === null}
            onClick={() => setOffset(page.snapshot!.nextOffset!)}
          >
            {t("runnerRecovery.next")}
          </Button>
        </div>
      )}
    </div>
  );
}

function RecoveryBrowser() {
  const { t } = useTranslation();
  const [owners, setOwners] = useState<RecoveryOwners | null>(null),
    [owner, setOwner] = useState("");
  const [offset, setOffset] = useState(0),
    [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void client
      .owners()
      .then((next) => {
        if (active) {
          setOwners(next);
          setOwner(next.ids[0] ?? "");
        }
      })
      .catch((error) => {
        if (active) setError(translateError(error));
      });
    return () => {
      active = false;
    };
  }, []);
  return (
    <div className="runner-recovery__browser">
      {error && <RecoveryError message={error} />}
      {!owners && !error && <p role="status">{t("common.loading")}</p>}
      {owners?.limited && <p className="settings-hint">{t("runnerRecovery.limited")}</p>}
      {owners?.ids.length === 0 && <p className="settings-hint">{t("runnerRecovery.empty")}</p>}
      {owners && owners.ids.length > 0 && (
        <>
          <Select
            label={t("runnerRecovery.plugin")}
            value={owner}
            options={owners.ids.map((id) => ({ value: id, label: id }))}
            onChange={(id) => {
              setOwner(id);
              setOffset(0);
            }}
          />
          <RecoveryPage
            key={`${owner}:${offset}`}
            pluginId={owner}
            offset={offset}
            setOffset={setOffset}
          />
        </>
      )}
    </div>
  );
}

export function RunnerRecoverySection() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <section className="settings-subsection runner-recovery" aria-label={t("runnerRecovery.title")}>
      <details onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary>
          <ChevronRight size={14} aria-hidden="true" />
          <h3 className="settings-subtitle">{t("runnerRecovery.title")}</h3>
        </summary>
        <p className="settings-hint">{t("runnerRecovery.description")}</p>
        {open && <RecoveryBrowser />}
      </details>
    </section>
  );
}
