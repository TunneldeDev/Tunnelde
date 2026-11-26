import { ForwardingSection } from "@/features/forwarding/ForwardingSection";
import { HostFieldsSection } from "./HostFieldsSection";
import { HostDetailsSections } from "./HostDetailsSections";
import { Activity, List, Copy, FolderTree, Pencil, PlugZap, Star, Trash2 } from "lucide-react";
import { usePanelLeaseAction } from "@/lib/panels/interaction";
import { executeHostPanelCommand } from "./panel/execute";
import { notifyError } from "@/lib/api/errors";
import type { ReactNode } from "react";
import { useHostPanel } from "./panel/context";
import type { HostDetailOperation } from "./detail/protocol";
import { useTranslation } from "react-i18next";

import { Button, IconButton } from "@/components/ui/form/Button";
import { EmptyState, StatusDot } from "@/components/ui/display/Misc";
import { formatDateTime, formatRelative, hostSubtitle } from "@/lib/text/format";
import { AUTH_LABELS } from "@/lib/prefs/labels";
import type { Host } from "@/lib/api/types";

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="detail">
      <dt className="detail__label">{label}</dt>
      <dd className="detail__value">{value}</dd>
    </div>
  );
}

export interface HostPageServices {
  connect(): void;
  sftp(): void;
  monitor(): void;
  processes(): void;
  favorite(): void;
  edit(): void;
  remove(): void;
  duplicate(): void;
}
/** Shared production page: display data and explicitly supplied effects only. */
export function HostPageView({
  host,
  groupName,
  hostCount,
  services,
  children,
}: {
  host: Host | null;
  groupName?: string;
  hostCount: number;
  services: HostPageServices;
  children?: ReactNode;
}) {
  const { t, i18n } = useTranslation();
  const locale = i18n.resolvedLanguage ?? "en-US";
  if (!host)
    return (
      <div className="page">
        <EmptyState
          icon={<StatusDot tone="warn" />}
          title={t("host.emptyTitle")}
          body={t("host.emptyBody")}
        />
      </div>
    );
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
          <IconButton
            label={t(host.source ? "hostSources.saveCopy" : "common.duplicate")}
            size="sm"
            onClick={services.duplicate}
          >
            <Copy size={15} />
          </IconButton>
          <Button
            variant="primary"
            size="sm"
            leading={<PlugZap size={13} />}
            onClick={services.connect}
          >
            {t("terminal.connect")}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            leading={<FolderTree size={13} />}
            onClick={services.sftp}
          >
            {t("sftp.title")}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            leading={<Activity size={13} />}
            onClick={services.monitor}
          >
            {t("monitor.open")}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            leading={<List size={13} />}
            onClick={services.processes}
          >
            {t("processes.title")}
          </Button>
          {!host.source && (
            <>
              <IconButton
                label={host.favorite ? t("menu.unfavorite") : t("menu.favorite")}
                active={host.favorite}
                size="sm"
                onClick={services.favorite}
              >
                <Star size={15} fill={host.favorite ? "currentColor" : "none"} />
              </IconButton>
              <IconButton label={t("common.edit")} size="sm" onClick={services.edit}>
                <Pencil size={15} />
              </IconButton>
              <IconButton label={t("common.delete")} size="sm" danger onClick={services.remove}>
                <Trash2 size={15} />
              </IconButton>
            </>
          )}
        </div>
      </header>

      <section className="card">
        <h2 className="card__title">{t("host.details")}</h2>
        <dl className="detail-grid">
          <Detail label={t("host.address")} value={host.host} />
          <Detail label={t("host.port")} value={String(host.port)} />
          <Detail label={t("host.username")} value={host.username || "—"} />
          <Detail label={t("host.authMethod")} value={t(AUTH_LABELS[host.authMethod])} />
          <Detail label={t("host.group")} value={groupName ?? t("common.none")} />
          {host.authMethod === "key" ? (
            <Detail label={t("host.keyPath")} value={host.keyPath ?? "—"} />
          ) : null}
          <Detail
            label={t("host.lastUsed")}
            value={host.lastUsedAt ? formatRelative(host.lastUsedAt, locale) : t("common.never")}
          />
          {!host.source && (
            <Detail label={t("host.created")} value={formatDateTime(host.createdAt, locale)} />
          )}
          {host.source && (
            <Detail
              label={t("hostSources.source")}
              value={`${host.source.pluginName} · ${host.source.label}`}
            />
          )}
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

      {children}
      <div className="host-page__foot">
        <span className="host-page__count">{t("status.hosts", { count: hostCount })}</span>
      </div>
    </div>
  );
}

/** Main-only composition retains plugin renderers and singleton dialogs. */
export function HostPage({ hostId }: { hostId: string | null }) {
  const data = useHostPanel();
  const host = data.data.hosts.find((item) => item.id === hostId) ?? null;
  const action = usePanelLeaseAction();
  const run = (operation: HostDetailOperation) => {
    if (!host) return;
    const command = { operation, host: data.hostTarget(host.id) };
    void (action({ kind: "hostDetail", command }) ?? executeHostPanelCommand(command)).catch(
      (error) => notifyError(error, { domain: "hosts.detail", operation }),
    );
  };
  return (
    <HostPageView
      host={host}
      groupName={data.data.groups.find((group) => group.id === host?.groupId)?.name}
      hostCount={data.data.hosts.length}
      services={{
        connect: () => run("connect"),
        sftp: () => run("sftp"),
        monitor: () => run("monitor"),
        processes: () => run("processes"),
        favorite: () => run("favorite"),
        edit: () => run("edit"),
        remove: () => run("delete"),
        duplicate: () => run("duplicate"),
      }}
    >
      {host && (
        <>
          <ForwardingSection key={host.id} host={host} />
          {!host.source && <HostFieldsSection key={`fields:${host.id}`} hostId={host.id} />}
          {!host.source && <HostDetailsSections key={`details:${host.id}`} hostId={host.id} />}
        </>
      )}
    </HostPageView>
  );
}
