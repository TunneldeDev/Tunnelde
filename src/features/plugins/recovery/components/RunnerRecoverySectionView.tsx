import type { RunnerRecoveryServices } from "../data/services";
import { useEffect, useState } from "react";
import { ChevronRight, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/form/Button";
import { Select } from "@/components/ui/form/Select";
import { translateError } from "@/lib/api/errors";
import type { RecoveryOwners } from "@/lib/runners/recovery/contracts";
import { useRecoveryPageModel } from "../runtime/useRecoveryPageModel";
import { RecoveryRecord } from "./RecoveryRecord";
import "./recovery.css";

function RecoveryError({
  message,
  services,
}: {
  message: string;
  services: RunnerRecoveryServices;
}) {
  const { t } = useTranslation();
  const [logError, setLogError] = useState<string | null>(null);
  return (
    <div className="settings-message is-error" role="alert">
      <p>{message}</p>
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          void services.openLog().catch((error) => setLogError(translateError(error)));
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
  services,
}: {
  services: RunnerRecoveryServices;
  pluginId: string;
  offset: number;
  setOffset: (offset: number) => void;
}) {
  const { t } = useTranslation();
  const page = useRecoveryPageModel(pluginId, offset, services);
  const files = services.useFiles(pluginId);
  const { useViewState, useBusyGuard } = services;
  const [expanded, setExpanded] = useViewState<Record<string, boolean>>(
    `recovery:${pluginId}:${offset}:expanded`,
    {},
  );
  useBusyGuard(page.pending || files.pending);
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
      {page.error && <RecoveryError message={page.error} services={services} />}
      {files.error && <RecoveryError message={files.error} services={services} />}
      {files.renderConnection()}
      {page.snapshot?.entries.length === 0 && (
        <p className="settings-hint">{t("runnerRecovery.empty")}</p>
      )}
      {page.snapshot?.entries.map((entry) => (
        <RecoveryRecord
          key={JSON.stringify([entry.runnerId, entry.hostId, entry.directory])}
          entry={entry}
          open={expanded[entry.token] === true}
          onOpenChange={(opened) =>
            setExpanded((previous) => ({ ...previous, [entry.token]: opened }))
          }
          observation={page.observations[entry.token]}
          capabilities={page.capabilities[entry.token]}
          pending={page.pending || files.pending}
          onBrowse={() => void files.browse(entry)}
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

function RecoveryBrowser({ services }: { services: RunnerRecoveryServices }) {
  const { t } = useTranslation();
  const { client, useViewState } = services;
  const [owners, setOwners] = useState<RecoveryOwners | null>(null),
    [owner, setOwner] = useViewState("recovery:owner", "");
  const [offset, setOffset] = useViewState("recovery:offset", 0),
    [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void client
      .owners()
      .then((next) => {
        if (active) {
          setOwners(next);
          setOwner((previous) => (next.ids.includes(previous) ? previous : (next.ids[0] ?? "")));
        }
      })
      .catch((error) => {
        if (active) setError(translateError(error));
      });
    return () => {
      active = false;
    };
  }, [client, setOwner]);
  return (
    <div className="runner-recovery__browser">
      {error && <RecoveryError message={error} services={services} />}
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
            services={services}
            offset={offset}
            setOffset={setOffset}
          />
        </>
      )}
    </div>
  );
}

export function RunnerRecoverySectionView({ services }: { services: RunnerRecoveryServices }) {
  const { t } = useTranslation();
  const { useViewState } = services;
  const [open, setOpen] = useViewState("recovery:open", false);
  return (
    <section className="settings-subsection runner-recovery" aria-label={t("runnerRecovery.title")}>
      <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary>
          <ChevronRight size={14} aria-hidden="true" />
          <h3 className="settings-subtitle">{t("runnerRecovery.title")}</h3>
        </summary>
        <p className="settings-hint">{t("runnerRecovery.description")}</p>
        {open && <RecoveryBrowser services={services} />}
      </details>
    </section>
  );
}
