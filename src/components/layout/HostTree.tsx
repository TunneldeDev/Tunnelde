import {
  ChevronRight,
  FolderClosed,
  FolderPlus,
  LoaderCircle,
  Pencil,
  Plus,
  Server,
  Star,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useViewState } from "@/lib/session/viewState";
import { useTranslation } from "react-i18next";

import { Button, IconButton } from "@/components/ui/form/Button";
import { HostSearch } from "@/components/layout/HostSearch";
import { buildHostTree, type HostGroupNode } from "@/lib/hosts/tree";
import { Menu } from "@/components/ui/overlay/Menu";
import { EmptyState } from "@/components/ui/display/Misc";
import { cn, hostSubtitle } from "@/lib/text/format";
import { copyText } from "@/lib/session/clipboard";
import { connectHostDirectly } from "@/lib/session/connectHost";
import { useDialogs } from "@/store/dialogs";
import { useContextMenu } from "@/store/contextMenu";
import { useHosts } from "@/store/hosts";
import { useWorkspace } from "@/store/workspace";
import { useSettings } from "@/store/settings";
import { useSsh } from "@/store/ssh";
import type { Group, Host } from "@/lib/api/types";
import { SidebarDockControls, SidebarTitle } from "@/components/layout/SidebarDockControls";

const HOST_MIME = "application/x-tunnelde-host";

function connectTerminal(host: Host): void {
  if (useSettings.getState().settings.hostDirectConnect) void connectHostDirectly(host);
  else useDialogs.getState().openConnect(host, "terminal");
}

/** Single click and Enter follow the configured action. */
function activateHost(host: Host): void {
  switch (useSettings.getState().settings.hostActivation) {
    case "details":
      useWorkspace.getState().openHost(host, { preview: true });
      return;
    case "edit":
      useDialogs.getState().openHost(host);
      return;
    default:
      connectTerminal(host);
  }
}

interface HostRowProps {
  host: Host;
  active: boolean;
  focused: boolean;
  onFocusRow: () => void;
  depth?: number;
  canReorder: boolean;
}

function HostRow({ host, active, focused, onFocusRow, depth = 0, canReorder }: HostRowProps) {
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
  const connecting = useSsh((state) => state.connectingHostIds.includes(host.id));
  const [over, setOver] = useState<"before" | "after" | null>(null);
  const row = useRef<HTMLDivElement>(null);
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (clickTimer.current) clearTimeout(clickTimer.current);
    },
    [],
  );

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
    {
      label: t("menu.edit"),
      separatorBefore: true,
      icon: <Pencil size={13} />,
      onSelect: () => openHostDialog(host),
    },
    { label: t("menu.copySsh"), onSelect: () => copyText(command) },
    { label: t("menu.copyAddress"), onSelect: () => copyText(address) },
    {
      label: t("connect.installKey"),
      separatorBefore: true,
      onSelect: () => openConnect(host, "terminal", "installKey"),
    },
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
    {
      label: t("menu.delete"),
      separatorBefore: true,
      icon: <Trash2 size={13} />,
      danger: true,
      onSelect: removeHost,
    },
  ];

  return (
    <div
      ref={row}
      className={cn("host-row", active && "is-active", focused && "is-focused", over && "is-drop")}
      style={{
        ...(depth > 0 ? { paddingLeft: 15 + depth * 12 } : {}),
        ...(over
          ? { boxShadow: `inset 0 ${over === "before" ? "2px" : "-2px"} 0 var(--td-accent)` }
          : {}),
      }}
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
      onClick={(event) => {
        if (event.target instanceof Element && event.target.closest("button, [role='menu']"))
          return;
        onFocusRow();
        if (event.detail > 1) return;
        if (useSettings.getState().settings.hostActivation === "details") activateHost(host);
        else {
          if (clickTimer.current) clearTimeout(clickTimer.current);
          clickTimer.current = setTimeout(() => {
            clickTimer.current = null;
            activateHost(host);
          }, 300);
        }
      }}
      onDoubleClick={(event) => {
        if (event.target instanceof Element && event.target.closest("button, [role='menu']"))
          return;
        if (clickTimer.current) clearTimeout(clickTimer.current);
        clickTimer.current = null;
        onFocusRow();
        connectTerminal(host);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onFocusRow();
        openMenu(event.clientX, event.clientY, menuItems);
      }}
      role="treeitem"
      aria-busy={connecting || undefined}
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
      {connecting ? (
        <LoaderCircle
          size={13}
          className="host-row__connecting"
          aria-label={t("connect.connecting")}
          role="status"
        />
      ) : null}
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
    {
      label: t("menu.rename"),
      separatorBefore: true,
      icon: <Pencil size={13} />,
      onSelect: onRename,
    },
    {
      label: t("menu.delete"),
      separatorBefore: true,
      icon: <Trash2 size={13} />,
      danger: true,
      onSelect: onDelete,
    },
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
        openMenu(event.clientX, event.clientY, actions, event.currentTarget);
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
  const [query, setQuery] = useViewState("hosts:query", "");
  const [collapsed, setCollapsed] = useViewState<Set<string>>("hosts:collapsed", new Set());
  const [searchCollapse, setSearchCollapse] = useState({ query: "", ids: new Set<string>() });

  const tags = useMemo(
    () => Array.from(new Set(hosts.flatMap((host) => host.tags))).sort(),
    [hosts],
  );
  const tree = useMemo(() => buildHostTree(groups, hosts, query.trim()), [groups, hosts, query]);
  const searching = query.trim().length > 0;
  const canReorder = !searching;

  const toggle = (id: string) => {
    if (searching) {
      setSearchCollapse((current) => {
        const ids = new Set(current.query === query ? current.ids : []);
        if (ids.has(id)) ids.delete(id);
        else ids.add(id);
        return { query, ids };
      });
      return;
    }
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
  }, [focusId, query, collapsed, searchCollapse, hosts, groups]);

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
        if (event.key === "Enter" && !event.repeat && !event.nativeEvent.isComposing)
          activateHost(host);
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

  const renderGroup = (
    { group, hosts: members, children, count }: HostGroupNode,
    depth = 0,
  ): React.ReactNode => {
    const isCollapsed = searching
      ? searchCollapse.query === query && searchCollapse.ids.has(group.id)
      : collapsed.has(group.id);
    return (
      <div key={group.id} role="group">
        <GroupRow
          group={group}
          count={count}
          depth={depth}
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
        {!isCollapsed ? (
          <>
            {members.map((host) => (
              <HostRow
                key={host.id}
                host={host}
                depth={depth + 1}
                active={host.id === activeHostId}
                {...rowProps(host)}
              />
            ))}
            {children.map((child) => renderGroup(child, depth + 1))}
          </>
        ) : null}
      </div>
    );
  };

  return (
    <div className="sidebar">
      <div className="sidebar__head" role="toolbar" aria-label={t("sidebar.hosts")}>
        <SidebarTitle view="hosts">{t("sidebar.hosts")}</SidebarTitle>
        <IconButton size="sm" label={t("sidebar.newHost")} onClick={() => openHostDialog()}>
          <Plus size={15} />
        </IconButton>
        <IconButton size="sm" label={t("sidebar.newGroup")} onClick={() => openGroupDialog()}>
          <FolderPlus size={15} />
        </IconButton>
        <SidebarDockControls view="hosts" />
      </div>
      <div className="sidebar__search">
        <HostSearch
          query={query}
          tags={tags}
          onChange={(value) => {
            setQuery(value);
            setSearchCollapse({ query: value, ids: new Set() });
          }}
        />
      </div>

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

        {tree.groups.map((node) => (
          <section className="tree-section" key={node.group.id}>
            {renderGroup(node)}
          </section>
        ))}

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
