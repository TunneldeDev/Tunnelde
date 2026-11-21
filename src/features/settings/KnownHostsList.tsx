import { RefreshCw, Trash2 } from "lucide-react";
import { SearchField } from "@/components/ui/form/SearchField";
import { matchesSearch, matchesSearchNumber, parseSearchQuery } from "@/lib/search/query";
import { useEffect, useRef, useState } from "react";
import { ConfirmDialog } from "@/components/ui/overlay/ConfirmDialog";
import { usePanelInteraction } from "@/lib/panels/interaction";
import { useKnownHostsModel } from "@/lib/panels/knownHostsModel";
import { usePanelViewState } from "@/lib/panels/viewState";
import { useTranslation } from "react-i18next";

import { IconButton } from "@/components/ui/form/Button";
import { PanelHeader } from "@/components/layout/WorkbenchPanel";
import { translateError } from "@/lib/api/errors";
import type { KnownHostEntry } from "@/lib/api/types";
import { toast } from "@/store/toasts";

export function KnownHostsList({
  active = true,
  variant = "page",
}: {
  active?: boolean;
  variant?: "page" | "sidebar";
} = {}) {
  const { t } = useTranslation();
  const { entries, loading, error, refresh, forget } = useKnownHostsModel(active);
  const [query, setQuery] = usePanelViewState(
    "known-hosts-query",
    "",
    (value): value is string => typeof value === "string",
  );
  const acquire = usePanelInteraction();
  const [confirmation, setConfirmation] = useState<{
    entry: KnownHostEntry;
    release: () => Promise<void>;
  } | null>(null);
  const opening = useRef(false);
  const alive = useRef(false);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const openForget = async (entry: KnownHostEntry) => {
    if (opening.current || confirmation) return;
    opening.current = true;
    try {
      const release = await acquire();
      if (!alive.current) {
        await release();
        return;
      }
      setConfirmation({ entry: { ...entry }, release });
    } catch (cause) {
      if (alive.current) toast(translateError(cause), "error");
    } finally {
      opening.current = false;
    }
  };
  const closeConfirmation = () => {
    if (!confirmation) return;
    setConfirmation(null);
    void confirmation.release().catch((cause: unknown) => toast(translateError(cause), "error"));
  };

  const search = query.trim().toLocaleLowerCase();
  const parsed = parseSearchQuery(query, ["host", "port", "algorithm"]);
  const visible = (entries ?? []).filter((entry) =>
    matchesSearch(parsed, `${entry.host}:${entry.port} ${entry.algorithm} ${entry.fingerprint}`, {
      host: (value) => entry.host.toLocaleLowerCase().includes(value),
      port: (value) => matchesSearchNumber(entry.port, value),
      algorithm: entry.algorithm,
    }),
  );
  const sidebar = variant === "sidebar";
  const searchInput = (
    <SearchField
      type="search"
      data-panel-focus="known-hosts.query"
      aria-label={t("settings.knownHostsSearch")}
      filterKeys={["host", "port", "algorithm"]}
      placeholder={t("settings.knownHostsSearch")}
      value={query}
      onChange={setQuery}
      presets={[
        { key: "host", value: "", label: t("searchUi.host") },
        { key: "port", value: "22", label: "SSH · 22" },
        ...[...new Set((entries ?? []).map((entry) => entry.algorithm))].map((value) => ({
          key: "algorithm",
          value,
          label: value,
        })),
      ]}
    />
  );
  const refreshButton = (
    <IconButton
      label={t("common.refresh")}
      disabled={loading}
      onClick={() => {
        void refresh().catch((cause: unknown) => toast(translateError(cause), "error"));
      }}
    >
      <RefreshCw size={14} />
    </IconButton>
  );
  const content = (
    <>
      {loading ? (
        <p role="status" className="settings-hint">
          {t("common.loading")}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="panel__error">
          {error}
        </p>
      ) : null}
      {!loading && !error && visible.length === 0 ? (
        <p className="settings-hint">
          {t(search ? "common.noResults" : "settings.knownHostsEmpty")}
        </p>
      ) : null}
      {visible.map((entry) => (
        <div className="known-host" key={`${entry.host}:${entry.port}`}>
          <span className="known-host__address" title={`${entry.host}:${entry.port}`}>
            {entry.host}:{entry.port}
          </span>
          <span className="known-host__algorithm">{entry.algorithm}</span>
          <code className="known-host__fingerprint" title={entry.fingerprint}>
            {entry.fingerprint}
          </code>
          <IconButton
            label={t("settings.knownHostsForget")}
            size="sm"
            danger
            onClick={() => void openForget(entry)}
          >
            <Trash2 size={12} />
          </IconButton>
        </div>
      ))}
    </>
  );
  return (
    <div className={sidebar ? "trusted-hosts-sidebar" : "known-hosts"} aria-busy={loading}>
      {sidebar ? <PanelHeader view="knownHosts">{refreshButton}</PanelHeader> : null}
      <div className={sidebar ? "sidebar__search" : "known-hosts-toolbar"}>
        {searchInput}
        {!sidebar ? refreshButton : null}
      </div>
      {sidebar ? (
        <div className="sidebar__body" data-panel-scroll="known-hosts.content">
          {content}
        </div>
      ) : (
        content
      )}
      {confirmation ? (
        <ConfirmDialog
          title={t("settings.knownHostsForgetTitle")}
          body={`${t("settings.knownHostsForgetBody", { host: confirmation.entry.host, port: confirmation.entry.port })}\n${confirmation.entry.algorithm} · ${confirmation.entry.fingerprint}`}
          confirmLabel={t("settings.knownHostsForget")}
          danger
          onConfirm={async () => {
            await forget(confirmation.entry);
          }}
          onClose={closeConfirmation}
        />
      ) : null}
    </div>
  );
}
