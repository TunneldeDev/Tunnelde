// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import {
  ArrowUp,
  Check,
  Download,
  File as FileIcon,
  Folder,
  FolderPlus,
  PenLine,
  Pencil,
  RotateCw,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { Button, IconButton } from "@/components/ui/Button";
import { EmptyState, StatusDot } from "@/components/ui/Misc";
import { Input } from "@/components/ui/Field";
import { cn, formatBytes, formatDate } from "@/lib/format";
import { translateError } from "@/lib/errors";
import { api } from "@/lib/ipc";
import type { FileEntry, Listing } from "@/lib/types";
import { useDialogs } from "@/store/dialogs";
import { useHosts } from "@/store/hosts";
import { useSsh } from "@/store/ssh";
import { useTransfers } from "@/store/transfers";
import { useWorkspace } from "@/store/workspace";

type Side = "local" | "remote";

interface PaneState {
  listing: Listing | null;
  error: string | null;
  selected: FileEntry | null;
  busy: boolean;
}

interface Prompt {
  side: Side;
  mode: "mkdir" | "rename";
}

const EMPTY: PaneState = { listing: null, error: null, selected: null, busy: false };

function parentPath(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const cut = trimmed.replace(/[\\/][^\\/]*$/, "");
  if (!cut) {
    return "/";
  }
  if (/^[A-Za-z]:$/.test(cut)) {
    return `${cut}\\`;
  }
  return cut;
}

function joinPath(directory: string, name: string): string {
  const separator = directory.includes("\\") ? "\\" : "/";
  return directory.endsWith(separator) ? `${directory}${name}` : `${directory}${separator}${name}`;
}

interface PaneProps {
  side: Side;
  title: string;
  state: PaneState;
  prompt: Prompt | null;
  promptValue: string;
  onPromptChange: (value: string) => void;
  onPromptCommit: () => void;
  onPromptCancel: () => void;
  onNavigate: (path: string) => void;
  onRefresh: () => void;
  onSelect: (entry: FileEntry) => void;
  onEnter: (entry: FileEntry) => void;
  onNewFolder: () => void;
  onRename: () => void;
  onDelete: () => void;
  onTransfer: () => void;
  onEdit?: () => void;
  onOpenFile?: (entry: FileEntry) => void;
  locale: string;
}

function Pane({
  side,
  title,
  state,
  prompt,
  promptValue,
  onPromptChange,
  onPromptCommit,
  onPromptCancel,
  onNavigate,
  onRefresh,
  onSelect,
  onEnter,
  onNewFolder,
  onRename,
  onDelete,
  onTransfer,
  onEdit,
  onOpenFile,
  locale,
}: PaneProps) {
  const { t } = useTranslation();
  const [draftOverride, setDraftOverride] = useState<string | null>(null);
  const draft = draftOverride ?? state.listing?.path ?? "";

  const selected = state.selected;
  const transferLabel = side === "local" ? t("sftp.upload") : t("sftp.download");

  return (
    <section className="sftp-pane">
      <header className="sftp-pane__head">
        <span className="sftp-pane__title">{title}</span>
        <div className="sftp-pane__actions">
          <IconButton
            label={t("sftp.up")}
            size="sm"
            disabled={!state.listing}
            onClick={() => state.listing && onNavigate(parentPath(state.listing.path))}
          >
            <ArrowUp size={13} />
          </IconButton>
          <IconButton label={t("sftp.refresh")} size="sm" onClick={onRefresh}>
            <RotateCw size={13} />
          </IconButton>
          <IconButton label={t("sftp.newFolder")} size="sm" onClick={onNewFolder}>
            <FolderPlus size={13} />
          </IconButton>
          <IconButton label={t("sftp.rename")} size="sm" disabled={!selected} onClick={onRename}>
            <Pencil size={13} />
          </IconButton>
          <IconButton label={t("sftp.delete")} size="sm" disabled={!selected} onClick={onDelete}>
            <Trash2 size={13} />
          </IconButton>
          {onEdit ? (
            <IconButton
              label={t("editor.open")}
              size="sm"
              disabled={!selected || selected.isDir}
              onClick={onEdit}
            >
              <PenLine size={13} />
            </IconButton>
          ) : null}
          <Button
            variant="secondary"
            size="sm"
            disabled={!selected || selected.isDir}
            leading={side === "local" ? <Upload size={13} /> : <Download size={13} />}
            onClick={onTransfer}
          >
            {transferLabel}
          </Button>
        </div>
      </header>

      <div className="sftp-pane__path">
        <Input
          value={draft}
          spellCheck={false}
          aria-label={t("sftp.path")}
          onChange={(event) => setDraftOverride(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              setDraftOverride(null);
              onNavigate(draft.trim());
            }
          }}
        />
      </div>

      {prompt && prompt.side === side ? (
        <div className="sftp-pane__prompt">
          <Input
            autoFocus
            value={promptValue}
            spellCheck={false}
            placeholder={prompt.mode === "mkdir" ? t("sftp.folderName") : t("sftp.renameTo")}
            onChange={(event) => onPromptChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                onPromptCommit();
              }
              if (event.key === "Escape") {
                onPromptCancel();
              }
            }}
          />
          <IconButton label={t("common.save")} size="sm" onClick={onPromptCommit}>
            <Check size={13} />
          </IconButton>
          <IconButton label={t("common.cancel")} size="sm" onClick={onPromptCancel}>
            <X size={13} />
          </IconButton>
        </div>
      ) : null}

      <div className="sftp-pane__body">
        {state.error ? <p className="sftp-pane__error">{state.error}</p> : null}
        {state.listing && state.listing.entries.length === 0 ? (
          <p className="sftp-pane__empty">{t("sftp.empty")}</p>
        ) : null}
        {state.listing?.entries.map((entry) => (
          <div
            key={entry.path}
            role="option"
            aria-selected={selected?.path === entry.path}
            tabIndex={0}
            className={cn("sftp-row", selected?.path === entry.path && "is-selected")}
            onClick={() => onSelect(entry)}
            onDoubleClick={() => {
              if (entry.isDir) {
                onEnter(entry);
              } else {
                onSelect(entry);
                onOpenFile?.(entry);
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && entry.isDir) {
                onEnter(entry);
              }
            }}
          >
            <span className="sftp-row__icon">
              {entry.isDir ? <Folder size={13} /> : <FileIcon size={13} />}
            </span>
            <span className="sftp-row__name" title={entry.name}>{entry.name}</span>
            <span className="sftp-row__size">{entry.isDir ? "" : formatBytes(entry.size)}</span>
            <span className="sftp-row__time">
              {entry.modified ? formatDate(entry.modified, locale) : ""}
            </span>
          </div>
        ))}
      </div>

      <footer className="sftp-pane__foot">
        <span>{state.listing ? t("sftp.itemCount", { count: state.listing.entries.length }) : "—"}</span>
        {selected ? <span className="sftp-pane__selection">{selected.name}</span> : null}
      </footer>
    </section>
  );
}

export function SftpPage({ sessionId }: { sessionId: string }) {
  const { t, i18n } = useTranslation();
  const session = useSsh((state) => state.sessions.find((item) => item.id === sessionId) ?? null);
  const confirm = useDialogs((state) => state.confirm);
  const openConnect = useDialogs((state) => state.openConnect);
  const openEditor = useWorkspace((state) => state.openEditor);
  const hosts = useHosts((state) => state.hosts);
  const transfers = useTransfers((state) => state.items);
  const cancelTransfer = useTransfers((state) => state.cancel);

  const [local, setLocal] = useState<PaneState>(EMPTY);
  const [remote, setRemote] = useState<PaneState>(EMPTY);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [promptValue, setPromptValue] = useState("");

  const loadLocal = useCallback(async (path?: string) => {
    setLocal((current) => ({ ...current, busy: true }));
    try {
      const listing = await api.localList(path ?? null);
      setLocal({ listing, error: null, selected: null, busy: false });
    } catch (error) {
      setLocal((current) => ({ ...current, busy: false, error: translateError(error) }));
    }
  }, []);

  const loadRemote = useCallback(
    async (path?: string) => {
      setRemote((current) => ({ ...current, busy: true }));
      try {
        const listing = await api.sftpList(sessionId, path ?? null);
        setRemote({ listing, error: null, selected: null, busy: false });
      } catch (error) {
        setRemote((current) => ({ ...current, busy: false, error: translateError(error) }));
      }
    },
    [sessionId],
  );

  useEffect(() => {
    void loadLocal();
    void loadRemote();
  }, [loadLocal, loadRemote]);

  const host = hosts.find((entry) => entry.id === session?.hostId) ?? null;

  if (!session) {
    return (
      <div className="page">
        <EmptyState
          icon={<StatusDot tone="warn" />}
          title={t("sftp.noSession")}
          action={
            host ? (
              <Button
                variant="primary"
                onClick={() => openConnect(host, "sftp")}
              >
                {t("terminal.connect")}
              </Button>
            ) : undefined
          }
        />
      </div>
    );
  }

  const startPrompt = (side: Side, mode: Prompt["mode"], initial = "") => {
    setPrompt({ side, mode });
    setPromptValue(initial);
  };

  const commitPrompt = async () => {
    if (!prompt) {
      return;
    }
    const value = promptValue.trim();
    if (!value) {
      return;
    }
    const state = prompt.side === "local" ? local : remote;
    const listing = state.listing;
    if (!listing) {
      return;
    }

    try {
      if (prompt.mode === "mkdir") {
        const target = joinPath(listing.path, value);
        if (prompt.side === "local") {
          await api.localMkdir(target);
        } else {
          await api.sftpMkdir(sessionId, target);
        }
      } else if (state.selected) {
        const target = joinPath(parentPath(state.selected.path), value);
        if (prompt.side === "local") {
          await api.localRename(state.selected.path, target);
        } else {
          await api.sftpRename(sessionId, state.selected.path, target);
        }
      }
      setPrompt(null);
      if (prompt.side === "local") {
        await loadLocal(listing.path);
      } else {
        await loadRemote(listing.path);
      }
    } catch (error) {
      setPrompt(null);
      confirm({
        title: t("common.error"),
        body: translateError(error),
        confirmLabel: t("common.close"),
        onConfirm: () => undefined,
      });
    }
  };

  const deleteSelected = (side: Side) => {
    const state = side === "local" ? local : remote;
    const entry = state.selected;
    if (!entry) {
      return;
    }
    confirm({
      title: t("sftp.deleteTitle"),
      body: t("sftp.deleteBody", { name: entry.name }),
      confirmLabel: t("common.delete"),
      danger: true,
      onConfirm: async () => {
        if (side === "local") {
          await api.localDelete(entry.path, entry.isDir);
          await loadLocal(state.listing?.path);
        } else {
          await api.sftpDelete(sessionId, entry.path, entry.isDir);
          await loadRemote(state.listing?.path);
        }
      },
    });
  };

  const transfer = async (side: Side) => {
    const entry = (side === "local" ? local : remote).selected;
    if (!entry || entry.isDir) {
      return;
    }
    const localDir = local.listing?.path;
    const remoteDir = remote.listing?.path;
    if (!localDir || !remoteDir) {
      return;
    }
    try {
      if (side === "local") {
        await api.sftpUpload(sessionId, entry.path, joinPath(remoteDir, entry.name));
      } else {
        await api.sftpDownload(sessionId, entry.path, joinPath(localDir, entry.name));
      }
    } catch (error) {
      confirm({
        title: t("common.error"),
        body: translateError(error),
        confirmLabel: t("common.close"),
        onConfirm: () => undefined,
      });
    }
  };

  const locale = i18n.resolvedLanguage ?? "en-US";

  const paneProps = (side: Side): PaneProps => {
    const state = side === "local" ? local : remote;
    const loader = side === "local" ? loadLocal : loadRemote;
    return {
      side,
      title: side === "local" ? t("sftp.local") : t("sftp.remote"),
      state,
      prompt,
      promptValue,
      onPromptChange: setPromptValue,
      onPromptCommit: () => void commitPrompt(),
      onPromptCancel: () => setPrompt(null),
      onNavigate: (path) => void loader(path),
      onRefresh: () => void loader(state.listing?.path),
      onSelect: (entry) =>
        side === "local"
          ? setLocal((current) => ({ ...current, selected: entry }))
          : setRemote((current) => ({ ...current, selected: entry })),
      onEnter: (entry) => void loader(entry.path),
      onNewFolder: () => startPrompt(side, "mkdir"),
      onRename: () => state.selected && startPrompt(side, "rename", state.selected.name),
      onDelete: () => deleteSelected(side),
      onTransfer: () => void transfer(side),
      onEdit:
        side === "remote" && state.selected && !state.selected.isDir
          ? () => session && openEditor(session, state.selected!.path)
          : undefined,
      onOpenFile: side === "remote" ? (entry) => session && openEditor(session, entry.path) : undefined,
      locale,
    };
  };

  return (
    <div className="sftp-page">
      <header className="sftp-head">
        <StatusDot tone="ok" />
        <span className="sftp-head__title">{host?.name ?? session.title}</span>
        <span className="sftp-head__meta">{session.address}</span>
      </header>

      <div className="sftp-panes">
        <Pane {...paneProps("local")} />
        <Pane {...paneProps("remote")} />
      </div>

      {transfers.length > 0 ? (
        <footer className="sftp-transfers">
          {transfers.map((item) => {
            const percent =
              item.total > 0 ? Math.min(100, Math.round((item.transferred / item.total) * 100)) : 0;
            const stateLabel =
              item.status === "running"
                ? `${percent}%`
                : item.status === "done"
                  ? t("sftp.done")
                  : item.status === "cancelled"
                    ? t("sftp.cancelled")
                    : t("sftp.failed");
            return (
              <div key={item.id} className={cn("transfer", `is-${item.status}`)}>
                <span className="transfer__name">{item.name}</span>
                <span className="transfer__meter">
                  <span style={{ width: `${percent}%` }} />
                </span>
                <span className="transfer__state" title={item.error ?? undefined}>
                  {stateLabel}
                </span>
                {item.status === "running" ? (
                  <IconButton
                    label={t("sftp.cancelTransfer")}
                    size="sm"
                    onClick={() => cancelTransfer(item.id)}
                  >
                    <X size={12} />
                  </IconButton>
                ) : (
                  <span className="transfer__spacer" />
                )}
              </div>
            );
          })}
        </footer>
      ) : null}
    </div>
  );
}
