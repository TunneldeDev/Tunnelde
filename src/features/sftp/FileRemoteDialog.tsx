import { Plus, Server } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/form/Button";
import { SearchField } from "@/components/ui/form/SearchField";
import { parseHostQuery, matchesHostQuery } from "@/lib/hosts/query";
import { Dialog } from "@/components/ui/overlay/Dialog";
import { ConnectDialog } from "@/features/connect/ConnectDialog";
import type { Host, SshSession } from "@/lib/api/types";
import { hostSubtitle } from "@/lib/text/format";
import { useDialogs } from "@/store/dialogs";
import { useHosts } from "@/store/hosts";
import { useSsh } from "@/store/ssh";

function currentSession(host: Host, sessions: SshSession[]): SshSession | undefined {
  const address = `${host.username}@${host.host}:${host.port}`;
  return sessions.find(
    (session) =>
      session.hostId === host.id && session.address === address && session.purpose !== "forwarding",
  );
}

export function FileRemoteDialog({
  onClose,
  onConnected,
}: {
  onClose: () => void;
  onConnected: (session: SshSession) => void;
}) {
  const { t, i18n } = useTranslation();
  const hosts = useHosts((state) => state.hosts);
  const sessions = useSsh((state) => state.sessions);
  const [query, setQuery] = useState("");
  const [connecting, setConnecting] = useState<Host | null>(null);
  const matches = useMemo(() => {
    const search = parseHostQuery(query);
    const collator = new Intl.Collator(i18n.resolvedLanguage, {
      numeric: true,
      sensitivity: "base",
    });
    return hosts
      .filter((host) => matchesHostQuery(host, search))
      .sort((a, b) => Number(b.favorite) - Number(a.favorite) || collator.compare(a.name, b.name));
  }, [hosts, query, i18n.resolvedLanguage]);
  if (connecting)
    return (
      <ConnectDialog host={connecting} after="sftp" onClose={onClose} onConnected={onConnected} />
    );
  return (
    <Dialog
      open
      title={t("sftp.connectRemote")}
      closeLabel={t("common.close")}
      onClose={onClose}
      width={460}
      footer={
        <Button
          leading={<Plus size={13} />}
          onClick={() => {
            onClose();
            useDialogs.getState().openHost();
          }}
        >
          {t("sidebar.newHost")}
        </Button>
      }
    >
      <SearchField
        autoFocus
        aria-label={t("sftp.searchRemote")}
        filterKeys={["tag", "is", "name", "host", "user", "port"]}
        placeholder={t("sftp.searchRemote")}
        value={query}
        onChange={setQuery}
        presets={[
          { key: "is", value: "favorite", label: t("searchUi.favorite") },
          { key: "host", value: "", label: t("searchUi.host") },
          { key: "user", value: "", label: t("searchUi.user") },
          ...[...new Set(hosts.flatMap((host) => host.tags))].map((tag) => ({
            key: "tag",
            value: tag,
            label: tag,
          })),
        ]}
      />
      <div className="sftp-remotes">
        {matches.map((host) => (
          <button
            type="button"
            className="sftp-remotes__host"
            key={host.id}
            onClick={() => {
              const existing = currentSession(host, sessions);
              if (existing) {
                onConnected(existing);
                onClose();
              } else setConnecting(host);
            }}
          >
            <Server size={15} aria-hidden="true" />
            <span>
              <strong>{host.name}</strong>
              <small>{hostSubtitle(host.username, host.host, host.port)}</small>
            </span>
            {currentSession(host, sessions) ? <small>{t("sftp.connected")}</small> : null}
          </button>
        ))}
        {!matches.length ? (
          <p className="sftp-pane__empty">
            {t(hosts.length ? "sftp.noMatches" : "sftp.noSavedHosts")}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
