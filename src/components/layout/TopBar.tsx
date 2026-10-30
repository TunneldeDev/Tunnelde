// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import {
  ArrowUpCircle,
  CircleDot,
  Download,
  Activity,
  Blocks,
  FileText,
  FolderTree,
  History,
  Info,
  Pin,
  Server,
  Settings as SettingsIcon,
  Terminal,
  X,
} from "lucide-react";
import type { ComponentType } from "react";
import { useTranslation } from "react-i18next";

import { IconButton } from "@/components/ui/Button";
import { cn } from "@/lib/format";
import { useDialogs } from "@/store/dialogs";
import { useEditors } from "@/store/editors";
import { useUpdates } from "@/store/updates";
import { useWorkspace, type WorkspaceTab } from "@/store/workspace";

const ICONS: Record<WorkspaceTab["kind"], ComponentType<{ size?: number }>> = {
  welcome: CircleDot,
  host: Server,
  settings: SettingsIcon,
  about: Info,
  updates: Download,
  terminal: Terminal,
  sftp: FolderTree,
  editor: FileText,
  history: History,
  monitor: Activity,
  pluginView: Blocks,
};

const NAV_KEYS = {
  welcome: "nav.welcome",
  settings: "nav.settings",
  about: "nav.about",
  updates: "nav.updates",
  terminal: "nav.host",
} as const;

export function UpdatePill() {
  const state = useUpdates((value) => value.state);
  const openPage = useWorkspace((value) => value.openPage);

  if (!state?.available || state.skipped || !state.version) {
    return null;
  }

  return (
    <button type="button" className="td-update-pill" onClick={() => openPage("updates")}>
      <ArrowUpCircle size={13} />
      <span>{state.version}</span>
    </button>
  );
}

export function TopBar() {
  const { t } = useTranslation();
  const tabs = useWorkspace((value) => value.tabs);
  const activeId = useWorkspace((value) => value.activeId);
  const activate = useWorkspace((value) => value.activate);
  const close = useWorkspace((value) => value.close);
  const togglePin = useWorkspace((value) => value.togglePin);
  const openPage = useWorkspace((value) => value.openPage);
  const confirm = useDialogs((value) => value.confirm);

  const requestClose = (tab: WorkspaceTab) => {
    if (tab.kind === "editor" && useEditors.getState().isDirty(tab.id)) {
      confirm({
        title: t("editor.discardTitle"),
        body: t("editor.discardBody", { name: tab.title }),
        confirmLabel: t("editor.discard"),
        danger: true,
        onConfirm: () => {
          useEditors.getState().discard(tab.id);
          close(tab.id);
        },
      });
      return;
    }
    if (tab.kind === "editor") {
      useEditors.getState().discard(tab.id);
    }
    close(tab.id);
  };

  return (
    <header className="topbar">
      <div className="topbar__brand" title="Tunnelde">
        <img src="/brand/mark-64.png" alt="" width={18} height={18} draggable={false} />
        <span className="topbar__name">Tunnelde</span>
      </div>

      <div className="tabstrip" role="tablist" aria-label="Tunnels">
        {tabs.map((tab) => {
          const Icon = ICONS[tab.kind];
          const active = tab.id === activeId;
          return (
            <div
              key={tab.id}
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              className={cn("td-tab", active && "is-active", tab.pinned && "is-pinned")}
              onClick={() => activate(tab.id)}
              onAuxClick={(event) => {
                if (event.button === 1) {
                  requestClose(tab);
                }
              }}
              onDoubleClick={() => togglePin(tab.id)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  activate(tab.id);
                }
              }}
            >
              {tab.pinned ? <Pin size={11} className="td-tab__pin" /> : <Icon size={13} />}
              <span className="td-tab__label">
                {tab.kind === "host" ||
                tab.kind === "terminal" ||
                tab.kind === "sftp" ||
                tab.kind === "editor" ||
                tab.kind === "history" ||
                tab.kind === "monitor" ||
                tab.kind === "pluginView"
                  ? tab.title
                  : t(NAV_KEYS[tab.kind])}
              </span>
              <button
                type="button"
                className="td-tab__close"
                aria-label={t("tab.close")}
                onClick={(event) => {
                  event.stopPropagation();
                  requestClose(tab);
                }}
              >
                <X size={12} />
              </button>
            </div>
          );
        })}
      </div>

      <div className="topbar__actions">
        <UpdatePill />
        <IconButton label={t("nav.settings")} onClick={() => openPage("settings")}>
          <SettingsIcon size={15} />
        </IconButton>
      </div>
    </header>
  );
}
