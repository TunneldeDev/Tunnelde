// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import {
  ChevronRight,
  FolderClosed,
  FolderPlus,
  Pencil,
  Plus,
  Search,
  Server,
  Star,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button, IconButton } from "@/components/ui/form/Button";
import { Input } from "@/components/ui/form/Field";
import { Menu } from "@/components/ui/overlay/Menu";
import { EmptyState } from "@/components/ui/display/Misc";
import { cn, hostSubtitle } from "@/lib/text/format";
import { copyText } from "@/lib/session/clipboard";
import { useDialogs } from "@/store/dialogs";
import { useContextMenu } from "@/store/contextMenu";
import { useHosts } from "@/store/hosts";
import { useWorkspace } from "@/store/workspace";
import { useSettings } from "@/store/settings";
import type { Group, Host } from "@/lib/api/types";

const HOST_MIME = "application/x-tunnelde-host";

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
  focused: boolean;
  onFocusRow: () => void;
  nested?: boolean;
  canReorder: boolean;
}

function HostRow({ host, active, focused, onFocusRow, nested = false, canReorder }: HostRowProps) {
  const { t } = useTranslation();
  const openHost = useWorkspace((state) => state.openHost);
  const openHostDialog = useDialogs((state) => state.openHost);
  const confirm = useDialogs((state) => state.confirm);
  const toggleFavorite = useHosts((state) => state.toggleFavorite);
  const deleteHost = useHosts((state) => state.deleteHost);
  const moveHost = useHosts((state) => state.moveHost);
  const removeHostTab = useWorkspace((state) => state.removeHost);
  const openMenu = useContextMenu((state) => state.open);
  const openConnect = useDialogs((state) => state.openConnect);
  const groups = useHosts((state) => state.groups);
  const moveToGroup = useHosts((state) => state.moveToGroup);
  const os = useSettings((state) => state.info?.os);
  const [over, setOver] = useState<"before" | "after" | null>(null);
  const row = useRef<HTMLDivElement>(null);

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

  const quote = (value: string): string => {
    if (/^[A-Za-z0-9_.:@%[\]-]+$/.test(value)) return value;
    return os === "windows"
      ? `'${value.replaceAll("'", "''")}'`
      : `'${value.replaceAll("'", `'"'"'`)}'`;
  };
  const address = `${host.username ? `${host.username}@` : ""}${host.host.includes(":") && !host.host.startsWith("[") ? `[${host.host}]` : host.host}`;
  const command = [
    "ssh",
    ...(host.port !== 22 ? ["-p", String(host.port)] : []),
    ...(host.username ? ["-l", quote(host.username)] : []),
    ...(host.authMethod === "key" && host.keyPath ? ["-i", quote(host.keyPath)] : []),
    "--",
    quote(host.host),
  ].join(" ");
  const menuItems = [
    { label: t("host.open"), onSelect: () => openHost(host) },
    { label: t("terminal.connect"), onSelect: () => openConnect(host, "terminal") },
    { label: t("sftp.title"), onSelect: () => openConnect(host, "sftp") },
    { label: t("menu.edit"), icon: <Pencil size={13} />, onSelect: () => openHostDialog(host) },
    { label: t("menu.copySsh"), onSelect: () => copyText(command) },
    { label: t("menu.copyAddress"), onSelect: () => copyText(address) },
    { label: t("connect.installKey"), onSelect: () => openConnect(host, "terminal", "installKey") },
    {
      label: t("menu.moveGroup"),
      onSelect: () => {
        const bounds = row.current?.getBoundingClientRect();
        openMenu(bounds?.left ?? 0, bounds?.bottom ?? 0, [
          { label: t("sidebar.ungrouped"), onSelect: () => moveToGroup(host.id, null) },
          ...groups.map((group) => ({
            label: group.name,
            onSelect: () => moveToGroup(host.id, group.id),
          })),
        ]);
      },
    },
    {
      label: host.favorite ? t("menu.unfavorite") : t("menu.favorite"),
      icon: <Star size={13} />,
      onSelect: () => void toggleFavorite(host),
    },
    { label: t("menu.delete"), icon: <Trash2 size={13} />, danger: true, onSelect: removeHost },
  ];

  return (
    <div
      ref={row}
      className={cn("host-row", nested && "is-nested", active && "is-active", over && "is-drop")}
      style={
        over
          ? { boxShadow: `inset 0 ${over === "before" ? "2px" : "-2px"} 0 var(--td-accent)` }
          : undefined
      }
      draggable={canReorder}
      onDragStart={(event) => {
        if (!canReorder) {
          event.preventDefault();
          return;
        }
        event.dataTransfer.setData(HOST_MIME, host.id);
        event.dataTransfer.effectAllowed = "move";
      }}
      onDragOver={(event) => {
        if (!canReorder || !event.dataTransfer.types.includes(HOST_MIME)) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "move";
        const bounds = event.currentTarget.getBoundingClientRect();
        setOver(event.clientY < bounds.top + bounds.height / 2 ? "before" : "after");
      }}
      onDragLeave={() => setOver(null)}
      onDrop={(event) => {
        const dragged = event.dataTransfer.getData(HOST_MIME);
        setOver(null);
        if (!canReorder || !dragged || dragged === host.id) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        const bounds = event.currentTarget.getBoundingClientRect();
        moveHost(
          dragged,
          host.id,
          event.clientY < bounds.top + bounds.height / 2 ? "before" : "after",
        );
      }}
      onClick={() => {
        onFocusRow();
        openHost(host);
      }}
      onDoubleClick={() => openHostDialog(host)}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onFocusRow();
        openMenu(event.clientX, event.clientY, menuItems);
      }}
      role="treeitem"
      aria-selected={focused}
      id={`host-${host.id}`}
      data-host-id={host.id}
      tabIndex={-1}
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
        <Menu label={t("common.more")} items={menuItems} />
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
  canReorder: boolean;
  onDropHost: (id: string) => void;
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
  canReorder,
  onDropHost,
}: GroupRowProps) {
  const { t } = useTranslation();
  const openMenu = useContextMenu((state) => state.open);
  const actions = [
    { label: t("menu.newHost"), icon: <Plus size={13} />, onSelect: onNewHost },
    { label: t("menu.rename"), icon: <Pencil size={13} />, onSelect: onRename },
    { label: t("menu.delete"), icon: <Trash2 size={13} />, danger: true, onSelect: onDelete },
  ];
  return (
    <div
      className="group-row"
      style={{ paddingLeft: 8 + depth * 12 }}
      onClick={onToggle}
      onDragOver={(event) => {
        if (!canReorder || !event.dataTransfer.types.includes(HOST_MIME)) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "move";
      }}
      onDrop={(event) => {
        if (!canReorder) return;
        const id = event.dataTransfer.getData(HOST_MIME);
        if (!id) return;
        event.preventDefault();
        event.stopPropagation();
        onDropHost(id);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        openMenu(event.clientX, event.clientY, actions);
      }}
      role="button"
      tabIndex={0}
      aria-expanded={!collapsed}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (
          event.key === "Enter" ||
          event.key === " " ||
          (event.key === "ArrowRight" && collapsed) ||
          (event.key === "ArrowLeft" && !collapsed)
        ) {
          event.preventDefault();
          event.stopPropagation();
          onToggle();
        }
      }}
    >
      <ChevronRight size={12} className={cn("group-row__chevron", !collapsed && "is-open")} />
      <FolderClosed size={13} className="group-row__icon" />
      <span className="group-row__name">{group.name}</span>
      <span className="group-row__count">{count}</span>
      <span className="group-row__actions">
        <Menu label={t("common.more")} items={actions} />
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
  const moveToGroup = useHosts((state) => state.moveToGroup);
  const [query, setQuery] = useState("");
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const tags = useMemo(
    () => Array.from(new Set(hosts.flatMap((host) => host.tags))).sort(),
    [hosts],
  );
  const visibleHosts = useMemo(
    () => (tagFilter ? hosts.filter((host) => host.tags.includes(tagFilter)) : hosts),
    [hosts, tagFilter],
  );
  const tree = useMemo(
    () => buildTree(groups, visibleHosts, query.trim()),
    [groups, visibleHosts, query],
  );
  const searching = query.trim().length > 0 || !!tagFilter;
  const canReorder = !searching;

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

  const [focusId, setFocusId] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const rows = Array.from(bodyRef.current?.querySelectorAll<HTMLElement>("[data-host-id]") ?? []);
    const row = rows.find((item) => item.dataset.hostId === focusId);
    row?.scrollIntoView?.({ block: "nearest" });
    if (focusId && !row) setFocusId(null);
  }, [focusId, query, tagFilter, collapsed, hosts]);

  const dropHandlers = (groupId: string | null, favorite = false) => ({
    onDragOver: (event: React.DragEvent<HTMLElement>) => {
      if (!canReorder || !event.dataTransfer.types.includes(HOST_MIME)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
    },
    onDrop: (event: React.DragEvent<HTMLElement>) => {
      if (!canReorder) return;
      const id = event.dataTransfer.getData(HOST_MIME);
      if (!id) return;
      event.preventDefault();
      event.stopPropagation();
      const host = hosts.find((item) => item.id === id);
      moveToGroup(id, favorite ? (host?.groupId ?? null) : groupId, favorite);
    },
  });

  const moveFocus = (delta: number) => {
    const rows = Array.from(bodyRef.current?.querySelectorAll<HTMLElement>("[data-host-id]") ?? []);
    if (rows.length === 0) {
      return;
    }
    const current = rows.findIndex((row) => row.dataset.hostId === focusId);
    const next =
      current < 0
        ? delta < 0
          ? rows.length - 1
          : 0
        : Math.min(rows.length - 1, Math.max(0, current + delta));
    const id = rows[next]?.dataset.hostId;
    if (id) {
      setFocusId(id);
    }
  };

  const onTreeKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) {
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      moveFocus(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      const rows = Array.from(
        bodyRef.current?.querySelectorAll<HTMLElement>("[data-host-id]") ?? [],
      );
      const id = (event.key === "Home" ? rows[0] : rows[rows.length - 1])?.dataset.hostId;
      if (id) {
        setFocusId(id);
      }
      return;
    }
    if ((event.key === "Enter" || event.key === " ") && focusId) {
      const host = hosts.find((item) => item.id === focusId);
      if (host) {
        event.preventDefault();
        useWorkspace.getState().openHost(host);
      }
    }
  };

  const rowProps = (host: Host) => ({
    focused: focusId === host.id,
    canReorder,
    onFocusRow: () => {
      setFocusId(host.id);
      bodyRef.current?.focus();
    },
  });

  return (
    <div className="sidebar">
      <div className="sidebar__head" role="toolbar" aria-label={t("sidebar.hosts")}>
        <div className="sidebar__filter">
          <Search size={13} aria-hidden="true" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("sidebar.search")}
            aria-label={t("sidebar.search")}
            spellCheck={false}
          />
        </div>
        <IconButton size="sm" label={t("sidebar.newHost")} onClick={() => openHostDialog()}>
          <Plus size={15} />
        </IconButton>
        <IconButton size="sm" label={t("sidebar.newGroup")} onClick={() => openGroupDialog()}>
          <FolderPlus size={15} />
        </IconButton>
      </div>

      {tags.length > 0 ? (
        <div className="sidebar__tags">
          {tags.map((tag) => (
            <button
              key={tag}
              type="button"
              className={cn("sidebar__tag", tagFilter === tag && "is-active")}
              onClick={() => setTagFilter(tagFilter === tag ? null : tag)}
            >
              {tag}
            </button>
          ))}
        </div>
      ) : null}

      <div
        ref={bodyRef}
        className="sidebar__body"
        role="tree"
        aria-label={t("sidebar.hosts")}
        tabIndex={0}
        aria-activedescendant={focusId ? `host-${focusId}` : undefined}
        onKeyDown={onTreeKeyDown}
      >
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

        {tree.favorites.length > 0 || (!isEmpty && !searching) ? (
          <section className="tree-section" role="group" {...dropHandlers(null, true)}>
            <h2 className="tree-section__title">{t("sidebar.favorites")}</h2>
            {tree.favorites.map((host) => (
              <HostRow
                key={`fav-${host.id}`}
                host={host}
                active={host.id === activeHostId}
                {...rowProps(host)}
              />
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
                onNewHost={() => openHostDialog(null, group.id)}
                canReorder={canReorder}
                onDropHost={(id) => moveToGroup(id, group.id)}
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
                    <HostRow
                      key={host.id}
                      host={host}
                      nested
                      active={host.id === activeHostId}
                      {...rowProps(host)}
                    />
                  ))
                : null}
              {!isCollapsed
                ? children.map((child) => (
                    <div key={child.group.id} role="group">
                      <GroupRow
                        group={child.group}
                        count={child.hosts.length}
                        depth={1}
                        collapsed={collapsed.has(child.group.id)}
                        onToggle={() => toggle(child.group.id)}
                        onNewHost={() => openHostDialog(null, child.group.id)}
                        canReorder={canReorder}
                        onDropHost={(id) => moveToGroup(id, child.group.id)}
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
                              {...rowProps(host)}
                            />
                          ))
                        : null}
                    </div>
                  ))
                : null}
            </section>
          );
        })}

        {tree.ungrouped.length > 0 || (!isEmpty && !searching) ? (
          <section className="tree-section" role="group" {...dropHandlers(null)}>
            {tree.groups.length > 0 || !searching ? (
              <h2 className="tree-section__title">{t("sidebar.ungrouped")}</h2>
            ) : null}
            {tree.ungrouped.map((host) => (
              <HostRow
                key={host.id}
                host={host}
                active={host.id === activeHostId}
                {...rowProps(host)}
              />
            ))}
          </section>
        ) : null}
      </div>
    </div>
  );
}
