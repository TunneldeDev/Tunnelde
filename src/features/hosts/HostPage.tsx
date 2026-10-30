// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { FolderTree, Pencil, PlugZap, Star, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button, IconButton } from "@/components/ui/Button";
import { EmptyState, StatusDot } from "@/components/ui/Misc";
import { formatDateTime, formatRelative, hostSubtitle } from "@/lib/format";
import { AUTH_LABELS } from "@/lib/labels";
import type { Host } from "@/lib/types";
import { useDialogs } from "@/store/dialogs";
import { useHosts } from "@/store/hosts";
import { useWorkspace } from "@/store/workspace";
import { useSsh } from "@/store/ssh";

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="detail">
      <dt className="detail__label">{label}</dt>
      <dd className="detail__value">{value}</dd>
    </div>
  );
}

function HostDetails({ host }: { host: Host }) {
  const { t, i18n } = useTranslation();
  const groups = useHosts((state) => state.groups);
  const hosts = useHosts((state) => state.hosts);
  const openHostDialog = useDialogs((state) => state.openHost);
  const openConnect = useDialogs((state) => state.openConnect);
  const openSftp = useWorkspace((state) => state.openSftp);
  const session = useSsh((state) => state.sessions.find((item) => item.hostId === host.id) ?? null);
  const confirm = useDialogs((state) => state.confirm);
  const deleteHost = useHosts((state) => state.deleteHost);
  const createHost = useHosts((state) => state.createHost);
  const toggleFavorite = useHosts((state) => state.toggleFavorite);
  const removeHostTab = useWorkspace((state) => state.removeHost);
  const openHost = useWorkspace((state) => state.openHost);
  const locale = i18n.resolvedLanguage ?? "en-US";

  const group = groups.find((item) => item.id === host.groupId);

  const duplicate = async () => {
    const copy = await createHost({
      name: `${host.name} ${t("common.duplicate")}`,
      host: host.host,
      port: host.port,
      username: host.username,
      authMethod: host.authMethod,
      groupId: host.groupId,
      color: host.color,
      tags: host.tags,
      note: host.note,
    });
    if (copy) {
      openHost(copy);
    }
  };

  return (
    <div className="page host-page">
      <header className="host-head">
        <span
          className="host-head__dot"
          style={host.color ? { background: host.color } : undefined}
        />
        <div className="host-head__text">
          <h1 className="host-head__title">{host.name}</h1>
          <p className="host-head__meta">{hostSubtitle(host.username, host.host, host.port)}</p>
        </div>
        <div className="host-head__actions">
          <Button
            variant="primary"
            size="sm"
            leading={<PlugZap size={13} />}
            onClick={() => openConnect(host)}
          >
            {t("terminal.connect")}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            leading={<FolderTree size={13} />}
            onClick={() => {
              if (session) {
                openSftp(session);
              } else {
                openConnect(host, "sftp");
              }
            }}
          >
            {t("sftp.title")}
          </Button>
          <IconButton
            label={host.favorite ? t("menu.unfavorite") : t("menu.favorite")}
            active={host.favorite}
            size="sm"
            onClick={() => void toggleFavorite(host)}
          >
            <Star size={15} fill={host.favorite ? "currentColor" : "none"} />
          </IconButton>
          <IconButton
            label={t("common.edit")}
            size="sm"
            onClick={() => openHostDialog(host)}
          >
            <Pencil size={15} />
          </IconButton>
          <IconButton
            label={t("common.delete")}
            size="sm"
            danger
            onClick={() =>
              confirm({
                title: t("host.deleteTitle"),
                body: t("host.deleteBody", { name: host.name }),
                confirmLabel: t("common.delete"),
                danger: true,
                onConfirm: async () => {
                  if (await deleteHost(host.id)) {
                    removeHostTab(host.id);
                  }
                },
              })
            }
          >
            <Trash2 size={15} />
          </IconButton>
        </div>
      </header>

      <section className="card">
        <h2 className="card__title">{t("host.details")}</h2>
        <dl className="detail-grid">
          <Detail label={t("host.address")} value={host.host} />
          <Detail label={t("host.port")} value={String(host.port)} />
          <Detail label={t("host.username")} value={host.username || "—"} />
          <Detail label={t("host.authMethod")} value={t(AUTH_LABELS[host.authMethod])} />
          <Detail label={t("host.group")} value={group?.name ?? t("common.none")} />
          {host.authMethod === "key" ? (
            <Detail label={t("host.keyPath")} value={host.keyPath ?? "—"} />
          ) : null}
          <Detail
            label={t("host.lastUsed")}
            value={host.lastUsedAt ? formatRelative(host.lastUsedAt, locale) : t("common.never")}
          />
          <Detail label={t("host.created")} value={formatDateTime(host.createdAt, locale)} />
        </dl>

        {host.tags.length > 0 ? (
          <div className="tag-row">
            {host.tags.map((tag) => (
              <span key={tag} className="td-tag">
                {tag}
              </span>
            ))}
          </div>
        ) : null}

        {host.note ? <p className="host-note">{host.note}</p> : null}
      </section>

      <div className="host-page__foot">
        <Button variant="secondary" onClick={() => void duplicate()}>
          {t("common.duplicate")}
        </Button>
        <span className="host-page__count">{t("status.hosts", { count: hosts.length })}</span>
      </div>
    </div>
  );
}

export function HostPage({ hostId }: { hostId: string | null }) {
  const { t } = useTranslation();
  const host = useHosts((state) => state.hosts.find((item) => item.id === hostId) ?? null);

  if (!host) {
    return (
      <div className="page">
        <EmptyState
          icon={<StatusDot tone="warn" />}
          title={t("host.emptyTitle")}
          body={t("host.emptyBody")}
        />
      </div>
    );
  }

  return <HostDetails host={host} />;
}
