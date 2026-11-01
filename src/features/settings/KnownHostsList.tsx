import { RefreshCw, Search, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { IconButton } from "@/components/ui/form/Button";
import { SidebarDockControls, SidebarTitle } from "@/components/layout/SidebarDockControls";
import { translateError } from "@/lib/api/errors";
import { api } from "@/lib/api/ipc";
import type { KnownHostEntry } from "@/lib/api/types";
import { useDialogs } from "@/store/dialogs";
import { toast } from "@/store/toasts";

export function KnownHostsList({
  active = true,
  variant = "page",
}: {
  active?: boolean;
  variant?: "page" | "sidebar";
} = {}) {
  const { t } = useTranslation();
  const confirm = useDialogs((state) => state.confirm);
  const [entries, setEntries] = useState<KnownHostEntry[] | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const request = useRef(0);

  const load = async () => {
    const version = ++request.current;
    try {
      const list = await api.knownHostsList();
      if (version === request.current) setEntries(list);
    } catch (cause) {
      if (version === request.current) setError(translateError(cause));
    } finally {
      if (version === request.current) setLoading(false);
    }
  };
  useEffect(() => {
    if (!active) return;
    let alive = true;
    queueMicrotask(() => {
      if (alive) {
        setLoading(true);
        setError(null);
        void load();
      }
    });
    const invalidate = () => {
      request.current++;
    };
    return () => {
      alive = false;
      invalidate();
    };
  }, [active]);

  const forget = (entry: KnownHostEntry) => {
    confirm({
      title: t("settings.knownHostsForgetTitle"),
      body: t("settings.knownHostsForgetBody", { host: entry.host, port: entry.port }),
      confirmLabel: t("settings.knownHostsForget"),
      danger: true,
      onConfirm: async () => {
        try {
          await api.knownHostsForget(entry.host, entry.port);
          request.current++;
          setLoading(false);
          setEntries(
            (current) =>
              current?.filter((item) => !(item.host === entry.host && item.port === entry.port)) ??
              null,
          );
        } catch (error) {
          toast(translateError(error), "error");
          throw error;
        }
      },
    });
  };

  const search = query.trim().toLocaleLowerCase();
  const visible = (entries ?? []).filter((entry) =>
    `${entry.host}:${entry.port} ${entry.algorithm} ${entry.fingerprint}`
      .toLocaleLowerCase()
      .includes(search),
  );
  const sidebar = variant === "sidebar";
  const searchInput = (
    <input
      className="td-input"
      type="search"
      aria-label={t("settings.knownHostsSearch")}
      placeholder={t("settings.knownHostsSearch")}
      value={query}
      onChange={(event) => setQuery(event.target.value)}
    />
  );
  const refresh = (
    <IconButton
      label={t("common.refresh")}
      disabled={loading}
      onClick={() => {
        setLoading(true);
        setError(null);
        void load();
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
            onClick={() => forget(entry)}
          >
            <Trash2 size={12} />
          </IconButton>
        </div>
      ))}
    </>
  );
  return (
    <div className={sidebar ? "trusted-hosts-sidebar" : "known-hosts"} aria-busy={loading}>
      {sidebar ? (
        <div className="sidebar__head">
          <SidebarTitle view="knownHosts">{t("settings.knownHosts")}</SidebarTitle>
          {refresh}
          <SidebarDockControls view="knownHosts" />
        </div>
      ) : null}
      <div className={sidebar ? "sidebar__search" : "known-hosts-toolbar"}>
        {sidebar ? (
          <div className="sidebar__filter">
            <Search size={13} aria-hidden="true" />
            {searchInput}
          </div>
        ) : (
          searchInput
        )}
        {!sidebar ? refresh : null}
      </div>
      {sidebar ? <div className="sidebar__body">{content}</div> : content}
    </div>
  );
}
