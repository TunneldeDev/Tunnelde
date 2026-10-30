// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import {
  ChevronRight,
  FolderClosed,
  FolderPlus,
  Pencil,
  Plus,
  Server,
  Settings as SettingsIcon,
  Star,
  Trash2,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button, IconButton } from "@/components/ui/form/Button";
import { Input } from "@/components/ui/form/Field";
import { Menu } from "@/components/ui/overlay/Menu";
import { EmptyState } from "@/components/ui/display/Misc";
import { cn, hostSubtitle } from "@/lib/text/format";
import { useDialogs } from "@/store/dialogs";
import { useContextMenu } from "@/store/contextMenu";
import { useHosts } from "@/store/hosts";
import { useWorkspace } from "@/store/workspace";
import type { Group, Host } from "@/lib/api/types";

interface Filtered {
  favorites: Host[];
  ungrouped: Host[];
  groups: Array<{ group: Group; hosts: Host[]; children: Array<{ group: Group; hosts: Host[] }> }>;
}

function matches(host: Host, query: string): boolean {
  if (!query) {
    return true;
  }
  const needle = query.toLowerCase();
  return (
    host.name.toLowerCase().includes(needle) ||
    host.host.toLowerCase().includes(needle) ||
    host.username.toLowerCase().includes(needle) ||
    host.tags.some((tag) => tag.toLowerCase().includes(needle))
  );
}

function buildTree(groups: Group[], hosts: Host[], query: string): Filtered {
  const visible = hosts.filter((host) => matches(host, query));
  const rest = visible.filter((host) => !host.favorite);
  const byGroup = new Map<string, Host[]>();
  for (const host of rest) {
    if (!host.groupId) {
      continue;
    }
    const bucket = byGroup.get(host.groupId) ?? [];
    bucket.push(host);
    byGroup.set(host.groupId, bucket);
  }

  const roots = groups.filter((group) => !group.parentId);
  const tree = roots
    .map((group) => {
      const children = groups
        .filter((child) => child.parentId === group.id)
        .map((child) => ({ group: child, hosts: byGroup.get(child.id) ?? [] }))
        .filter((child) => child.hosts.length > 0 || !query);
      return {
        group,
        hosts: byGroup.get(group.id) ?? [],
        children,
      };
    })
    .filter((node) => node.hosts.length > 0 || node.children.length > 0 || !query);

  return {
    favorites: visible.filter((host) => host.favorite),
    ungrouped: rest.filter((host) => !host.groupId),
    groups: tree,
  };
}

interface HostRowProps {
  host: Host;
  active: boolean;
  nested?: boolean;
}

function HostRow({ host, active, nested = false }: HostRowProps) {
  const { t } = useTranslation();
  const openHost = useWorkspace((state) => state.openHost);
  const openHostDialog = useDialogs((state) => state.openHost);
  const confirm = useDialogs((state) => state.confirm);
  const toggleFavorite = useHosts((state) => state.toggleFavorite);
  const deleteHost = useHosts((state) => state.deleteHost);
  const removeHostTab = useWorkspace((state) => state.removeHost);
  const openMenu = useContextMenu((state) => state.open);

  const removeHost = () =>
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
    });

  return (
    <div
      className={cn("host-row", nested && "is-nested", active && "is-active")}
      onClick={() => openHost(host)}
      onDoubleClick={() => openHostDialog(host)}
      onContextMenu={(event) => {
        event.preventDefault();
        openMenu(event.clientX, event.clientY, [
          { label: t("host.open"), onSelect: () => openHost(host) },
          { label: t("menu.edit"), onSelect: () => openHostDialog(host) },
          {
            label: host.favorite ? t("menu.unfavorite") : t("menu.favorite"),
            onSelect: () => void toggleFavorite(host),
          },
          { label: t("menu.delete"), danger: true, onSelect: removeHost },
        ]);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          openHost(host);
        }
      }}
      role="button"
      tabIndex={0}
    >
      <span
        className="host-row__dot"
        style={host.color ? { background: host.color } : undefined}
        aria-hidden="true"
      />
      <span className="host-row__text">
        <span className="host-row__name">{host.name}</span>
        <span className="host-row__meta">{hostSubtitle(host.username, host.host, host.port)}</span>
      </span>
      {host.favorite ? (
        <Star size={11} className="host-row__star" fill="currentColor" aria-hidden="true" />
      ) : null}
      <span className="host-row__actions">
        <Menu
          label={t("common.more")}
          items={[
            {
              label: t("menu.edit"),
              icon: <Pencil size={13} />,
              onSelect: () => openHostDialog(host),
            },
            {
              label: host.favorite ? t("menu.unfavorite") : t("menu.favorite"),
              icon: <Star size={13} />,
              onSelect: () => void toggleFavorite(host),
            },
            {
              label: t("menu.delete"),
              icon: <Trash2 size={13} />,
              danger: true,
              onSelect: removeHost,
            },
          ]}
        />
      </span>
    </div>
  );
}

interface GroupRowProps {
  group: Group;
  count: number;
  depth?: number;
  collapsed: boolean;
  onToggle: () => void;
  onNewHost: () => void;
  onRename: () => void;
  onDelete: () => void;
}

function GroupRow({
  group,
  count,
  depth = 0,
  collapsed,
  onToggle,
  onNewHost,
  onRename,
  onDelete,
}: GroupRowProps) {
  const { t } = useTranslation();
  return (
    <div
      className="group-row"
      style={{ paddingLeft: 8 + depth * 12 }}
      onClick={onToggle}
      role="button"
      tabIndex={-1}
    >
      <ChevronRight size={12} className={cn("group-row__chevron", !collapsed && "is-open")} />
      <FolderClosed size={13} className="group-row__icon" />
      <span className="group-row__name">{group.name}</span>
      <span className="group-row__count">{count}</span>
      <span className="group-row__actions">
        <Menu
          label={t("common.more")}
          items={[
            { label: t("menu.newHost"), icon: <Plus size={13} />, onSelect: onNewHost },
            { label: t("menu.rename"), icon: <Pencil size={13} />, onSelect: onRename },
            {
              label: t("menu.delete"),
              icon: <Trash2 size={13} />,
              danger: true,
              onSelect: onDelete,
            },
          ]}
        />
      </span>
    </div>
  );
}

export function HostTree() {
  const { t } = useTranslation();
  const groups = useHosts((state) => state.groups);
  const hosts = useHosts((state) => state.hosts);
  const activeHostId = useWorkspace((state) => {
    const tab = state.tabs.find((item) => item.id === state.activeId);
    return tab?.kind === "host" ? tab.hostId : null;
  });
  const openHostDialog = useDialogs((state) => state.openHost);
  const openGroupDialog = useDialogs((state) => state.openGroup);
  const confirm = useDialogs((state) => state.confirm);
  const deleteGroup = useHosts((state) => state.deleteGroup);
  const openPage = useWorkspace((state) => state.openPage);
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const tree = useMemo(() => buildTree(groups, hosts, query.trim()), [groups, hosts, query]);
  const searching = query.trim().length > 0;

  const toggle = (id: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const isEmpty = hosts.length === 0;

  return (
    <div className="sidebar">
      <div className="sidebar__head">
        <img src="/brand/mark-64.png" alt="" width={16} height={16} draggable={false} />
        <span className="sidebar__brand">Tunnelde</span>
      </div>

      <div className="sidebar__search">
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("sidebar.search")}
          aria-label={t("sidebar.search")}
          spellCheck={false}
        />
      </div>

      <div className="sidebar__body">
        {isEmpty ? (
          <EmptyState
            icon={<Server size={22} />}
            title={t("sidebar.empty")}
            action={
              <Button
                variant="secondary"
                size="sm"
                leading={<Plus size={13} />}
                onClick={() => openHostDialog()}
              >
                {t("sidebar.newHost")}
              </Button>
            }
          />
        ) : null}

        {!isEmpty &&
        searching &&
        tree.favorites.length === 0 &&
        tree.ungrouped.length === 0 &&
        tree.groups.length === 0 ? (
          <p className="sidebar__note">{t("sidebar.noResults")}</p>
        ) : null}

        {tree.favorites.length > 0 ? (
          <section className="tree-section">
            <h2 className="tree-section__title">{t("sidebar.favorites")}</h2>
            {tree.favorites.map((host) => (
              <HostRow key={`fav-${host.id}`} host={host} active={host.id === activeHostId} />
            ))}
          </section>
        ) : null}

        {tree.groups.map(({ group, hosts: groupHosts, children }) => {
          const isCollapsed = collapsed.has(group.id);
          return (
            <section className="tree-section" key={group.id}>
              <GroupRow
                group={group}
                count={
                  groupHosts.length +
                  children.reduce((total, child) => total + child.hosts.length, 0)
                }
                collapsed={isCollapsed}
                onToggle={() => toggle(group.id)}
                onNewHost={() => openHostDialog()}
                onRename={() => openGroupDialog(group)}
                onDelete={() =>
                  confirm({
                    title: t("group.deleteTitle"),
                    body: t("group.deleteBody", { name: group.name }),
                    confirmLabel: t("common.delete"),
                    danger: true,
                    onConfirm: async () => {
                      await deleteGroup(group.id);
                    },
                  })
                }
              />
              {!isCollapsed
                ? groupHosts.map((host) => (
                    <HostRow key={host.id} host={host} nested active={host.id === activeHostId} />
                  ))
                : null}
              {!isCollapsed
                ? children.map((child) => (
                    <div key={child.group.id}>
                      <GroupRow
                        group={child.group}
                        count={child.hosts.length}
                        depth={1}
                        collapsed={collapsed.has(child.group.id)}
                        onToggle={() => toggle(child.group.id)}
                        onNewHost={() => openHostDialog()}
                        onRename={() => openGroupDialog(child.group)}
                        onDelete={() =>
                          confirm({
                            title: t("group.deleteTitle"),
                            body: t("group.deleteBody", { name: child.group.name }),
                            confirmLabel: t("common.delete"),
                            danger: true,
                            onConfirm: async () => {
                              await deleteGroup(child.group.id);
                            },
                          })
                        }
                      />
                      {!collapsed.has(child.group.id)
                        ? child.hosts.map((host) => (
                            <HostRow
                              key={host.id}
                              host={host}
                              nested
                              active={host.id === activeHostId}
                            />
                          ))
                        : null}
                    </div>
                  ))
                : null}
            </section>
          );
        })}

        {tree.ungrouped.length > 0 ? (
          <section className="tree-section">
            {tree.groups.length > 0 ? (
              <h2 className="tree-section__title">{t("sidebar.ungrouped")}</h2>
            ) : null}
            {tree.ungrouped.map((host) => (
              <HostRow key={host.id} host={host} active={host.id === activeHostId} />
            ))}
          </section>
        ) : null}
      </div>

      <footer className="sidebar__foot">
        <Button
          variant="primary"
          size="sm"
          leading={<Plus size={13} />}
          onClick={() => openHostDialog()}
        >
          {t("sidebar.newHost")}
        </Button>
        <IconButton label={t("sidebar.newGroup")} onClick={() => openGroupDialog()}>
          <FolderPlus size={15} />
        </IconButton>
        <IconButton label={t("nav.settings")} onClick={() => openPage("settings")}>
          <SettingsIcon size={15} />
        </IconButton>
      </footer>
    </div>
  );
}
