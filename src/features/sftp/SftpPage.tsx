// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import {
  ArrowLeftRight,
  ArrowUp,
  File as FileIcon,
  FilePlus,
  Folder,
  FolderPlus,
  RotateCw,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { EmptyState, StatusDot } from "@/components/ui/display/Misc";
import { Button, IconButton } from "@/components/ui/form/Button";
import { Input } from "@/components/ui/form/Field";
import { Select } from "@/components/ui/form/Select";
import { translateError } from "@/lib/api/errors";
import type { FileEntry, FsSource, Listing } from "@/lib/api/types";
import {
  canPaste,
  joinPath,
  parentOf,
  planPaste,
  readDragPayload,
  resolveDrop,
  setDragPayload,
  type DragPayload,
} from "@/lib/files/dnd";
import { fs, LOCAL_SOURCE, sourceKey } from "@/lib/files/fs";
import { cn, formatBytes, formatDate } from "@/lib/text/format";
import { useContextMenu } from "@/store/contextMenu";
import { useDialogs } from "@/store/dialogs";
import { useFileClipboard } from "@/store/fileClipboard";
import { useHosts } from "@/store/hosts";
import { useSsh } from "@/store/ssh";
import { toast } from "@/store/toasts";
import { useTransfers } from "@/store/transfers";
import { useWorkspace } from "@/store/workspace";

type PaneId = "a" | "b";

const PANE_IDS: PaneId[] = ["a", "b"];

interface RenameState {
  path: string;
  value: string;
}

interface CreateState {
  kind: "file" | "folder";
  value: string;
}

interface PaneState {
  listing: Listing | null;
  error: string | null;
  selected: FileEntry | null;
  busy: boolean;
  draft: string | null;
  renaming: RenameState | null;
  creating: CreateState | null;
}

interface PaneModel {
  source: FsSource;
  state: PaneState;
}

const EMPTY: PaneState = {
  listing: null,
  error: null,
  selected: null,
  busy: false,
  draft: null,
  renaming: null,
  creating: null,
};

function separatorOf(source: FsSource): string {
  return source.kind === "remote" ? "/" : "\\";
}

function joinIn(source: FsSource, directory: string, name: string): string {
  return joinPath(directory, name, separatorOf(source));
}

function other(id: PaneId): PaneId {
  return id === "a" ? "b" : "a";
}

type TransferKey = "sftp.upload" | "sftp.download" | "sftp.copyToServer" | "sftp.copyToFolder";

function transferKey(from: FsSource, to: FsSource): TransferKey {
  if (from.kind === "local" && to.kind === "remote") {
    return "sftp.upload";
  }
  if (from.kind === "remote" && to.kind === "local") {
    return "sftp.download";
  }
  if (from.kind === "remote" && to.kind === "remote") {
    return "sftp.copyToServer";
  }
  return "sftp.copyToFolder";
}

export function SftpPage({ sessionId }: { sessionId: string }) {
  const { t, i18n } = useTranslation();
  const session = useSsh((state) => state.sessions.find((item) => item.id === sessionId) ?? null);
  const sessions = useSsh((state) => state.sessions);
  const confirm = useDialogs((state) => state.confirm);
  const openConnect = useDialogs((state) => state.openConnect);
  const openEditor = useWorkspace((state) => state.openEditor);
  const hosts = useHosts((state) => state.hosts);
  const transfers = useTransfers((state) => state.items);
  const cancelTransfer = useTransfers((state) => state.cancel);
  const clip = useFileClipboard((state) => state.clip);
  const setClip = useFileClipboard((state) => state.set);
  const clearClip = useFileClipboard((state) => state.clear);
  const openMenu = useContextMenu((state) => state.open);

  const [panes, setPanes] = useState<Record<PaneId, PaneModel>>(() => ({
    a: { source: LOCAL_SOURCE, state: EMPTY },
    b: { source: { kind: "remote", sessionId }, state: EMPTY },
  }));
  const [active, setActive] = useState<PaneId>("a");
  const [dropTarget, setDropTarget] = useState<{ pane: PaneId; path: string } | null>(null);
  const panesRef = useRef(panes);
  const bodies = useRef<Record<PaneId, HTMLDivElement | null>>({ a: null, b: null });
  const pending = useRef(new Set<string>());

  useEffect(() => {
    panesRef.current = panes;
  }, [panes]);

  const patch = useCallback((id: PaneId, next: Partial<PaneState>) => {
    setPanes((current) => ({
      ...current,
      [id]: { ...current[id], state: { ...current[id].state, ...next } },
    }));
  }, []);

  const reveal = useCallback((id: PaneId) => {
    requestAnimationFrame(() => {
      const row = document.querySelector(`[data-pane="${id}"] .sftp-row.is-selected`);
      if (row && typeof row.scrollIntoView === "function") {
        row.scrollIntoView({ block: "nearest" });
      }
    });
  }, []);

  const load = useCallback(
    async (
      id: PaneId,
      path?: string | null,
      keep?: string | null,
      override?: FsSource,
    ): Promise<Listing | null> => {
      const source = override ?? panesRef.current[id].source;
      patch(id, { busy: true, error: null });
      try {
        const listing = await fs.list(source, path ?? null);
        const selected = keep ? (listing.entries.find((item) => item.path === keep) ?? null) : null;
        patch(id, { listing, selected, busy: false, draft: null });
        if (selected) {
          reveal(id);
        }
        return listing;
      } catch (error) {
        patch(id, { busy: false, error: translateError(error) });
        return null;
      }
    },
    [patch, reveal],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load("a");
      void load("b");
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  // A panel that points at a session which has ended falls back to this computer.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const alive = new Set(sessions.map((item) => item.id));
      const stale = PANE_IDS.filter((id) => {
        const source = panesRef.current[id].source;
        return source.kind === "remote" && !alive.has(source.sessionId);
      });
      if (stale.length === 0) {
        return;
      }
      setPanes((current) => {
        const next = { ...current };
        for (const id of stale) {
          next[id] = { source: LOCAL_SOURCE, state: EMPTY };
        }
        return next;
      });
      for (const id of stale) {
        void load(id, null, null, LOCAL_SOURCE);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [sessions, load]);

  // Both panels refresh once a transfer they started has settled.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      let settled = false;
      for (const item of transfers) {
        if (item.status !== "running" && pending.current.has(item.id)) {
          pending.current.delete(item.id);
          settled = true;
        }
      }
      if (!settled) {
        return;
      }
      for (const id of PANE_IDS) {
        void load(id, panesRef.current[id].state.listing?.path ?? null);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [transfers, load]);

  const sourceOptions = useMemo(
    () => [
      { value: "local", label: t("sftp.thisComputer") },
      ...sessions.map((item) => ({ value: `remote:${item.id}`, label: item.title })),
    ],
    [sessions, t],
  );

  const locale = i18n.resolvedLanguage ?? "en-US";
  const host = hosts.find((entry) => entry.id === session?.hostId) ?? null;

  const revealRow = (id: PaneId, entry: FileEntry) => {
    patch(id, { selected: entry });
    bodies.current[id]?.focus();
    reveal(id);
  };

  const selectAt = (id: PaneId, index: number) => {
    const entry = panesRef.current[id].state.listing?.entries[index];
    if (entry) {
      revealRow(id, entry);
    }
  };

  const navigate = (id: PaneId, path: string) => {
    void load(id, path);
  };

  const startTransfer = async (
    from: FsSource,
    fromPath: string,
    to: FsSource,
    toPath: string,
    move: boolean,
  ) => {
    try {
      const transferId = await fs.transfer(from, fromPath, to, toPath, move);
      pending.current.add(transferId);
    } catch (error) {
      toast(translateError(error), "error");
    }
  };

  const transferSelected = (id: PaneId) => {
    const entry = panesRef.current[id].state.selected;
    const target = panesRef.current[other(id)];
    const directory = target.state.listing?.path;
    if (!entry || !directory) {
      return;
    }
    void startTransfer(
      panesRef.current[id].source,
      entry.path,
      target.source,
      joinIn(target.source, directory, entry.name),
      false,
    );
  };

  const cut = (id: PaneId, entry: FileEntry) => {
    setClip({
      source: panesRef.current[id].source,
      action: "cut",
      path: entry.path,
      name: entry.name,
      isDir: entry.isDir,
    });
  };

  const copy = (id: PaneId, entry: FileEntry) => {
    setClip({
      source: panesRef.current[id].source,
      action: "copy",
      path: entry.path,
      name: entry.name,
      isDir: entry.isDir,
    });
  };

  const pasteInto = (id: PaneId, directory: string) => {
    const target = panesRef.current[id].source;
    if (!clip) {
      return;
    }
    const action = planPaste(clip, target, directory);
    if (action.kind === "noop") {
      return;
    }
    if (action.kind === "move" || action.kind === "copy") {
      const run = action.kind === "move" ? fs.rename : fs.copy;
      void run
        .call(fs, action.source, action.from, action.to)
        .then(() => load(id, directory))
        .catch((error: unknown) => toast(translateError(error), "error"));
    } else {
      void startTransfer(action.from, action.fromPath, action.to, action.toPath, action.move);
    }
    if (clip.action === "cut") {
      clearClip();
    }
  };

  const handleDrop = (id: PaneId, directory: string, payload: DragPayload) => {
    const target = panesRef.current[id].source;
    const action = resolveDrop(payload, target, directory);
    if (action.kind === "noop") {
      return;
    }
    if (action.kind === "move" || action.kind === "copy") {
      const run = action.kind === "move" ? fs.rename : fs.copy;
      void run
        .call(fs, action.source, action.from, action.to)
        .then(() => load(id, directory))
        .catch((error: unknown) => toast(translateError(error), "error"));
    } else {
      void startTransfer(action.from, action.fromPath, action.to, action.toPath, action.move);
    }
  };

  const startRename = (id: PaneId, entry: FileEntry) => {
    patch(id, { selected: entry, renaming: { path: entry.path, value: entry.name } });
    reveal(id);
  };

  const commitRename = async (id: PaneId) => {
    const state = panesRef.current[id].state;
    const source = panesRef.current[id].source;
    const renaming = state.renaming;
    if (!renaming) {
      return;
    }
    const name = renaming.value.trim();
    const entry = state.listing?.entries.find((item) => item.path === renaming.path);
    if (!entry || !name || name === entry.name) {
      patch(id, { renaming: null });
      return;
    }
    const target = joinIn(source, parentOf(entry.path), name);
    try {
      await fs.rename(source, entry.path, target);
      patch(id, { renaming: null });
      await load(id, state.listing?.path ?? null, target);
      bodies.current[id]?.focus();
    } catch (error) {
      toast(translateError(error), "error");
    }
  };

  const startCreate = (id: PaneId, kind: "file" | "folder") => {
    patch(id, { creating: { kind, value: "" } });
  };

  const commitCreate = async (id: PaneId) => {
    const state = panesRef.current[id].state;
    const source = panesRef.current[id].source;
    const creating = state.creating;
    const directory = state.listing?.path;
    if (!creating || !directory) {
      return;
    }
    const name = creating.value.trim();
    if (!name) {
      patch(id, { creating: null });
      return;
    }
    const target = joinIn(source, directory, name);
    try {
      if (creating.kind === "folder") {
        await fs.mkdir(source, target);
      } else {
        await fs.createFile(source, target);
      }
      patch(id, { creating: null });
      await load(id, directory, target);
      bodies.current[id]?.focus();
    } catch (error) {
      toast(translateError(error), "error");
    }
  };

  const removeEntry = (id: PaneId, entry: FileEntry) => {
    const source = panesRef.current[id].source;
    confirm({
      title: t("sftp.deleteTitle"),
      body: t("sftp.deleteBody", { name: entry.name }),
      confirmLabel: t("common.delete"),
      danger: true,
      onConfirm: async () => {
        try {
          await fs.remove(source, entry.path, entry.isDir);
          await load(id, panesRef.current[id].state.listing?.path ?? null);
        } catch (error) {
          toast(translateError(error), "error");
        }
      },
    });
  };

  const applyEntry = (id: PaneId, entry: FileEntry) => {
    const source = panesRef.current[id].source;
    if (source.kind === "local") {
      void fs.openLocal(entry.path).catch((error: unknown) => toast(translateError(error), "error"));
      return;
    }
    const target = sessions.find((item) => item.id === source.sessionId);
    if (target) {
      openEditor(target, entry.path);
    }
  };

  const copyPath = (entry: FileEntry) => {
    void navigator.clipboard.writeText(entry.path).then(
      () => toast(t("sftp.copied"), "success"),
      () => toast(t("sftp.copyFailed"), "error"),
    );
  };

  const openEntryMenu = (event: React.MouseEvent, id: PaneId, entry: FileEntry | null) => {
    event.preventDefault();
    const source = panesRef.current[id].source;
    const directory = panesRef.current[id].state.listing?.path ?? "";
    const items: Array<{ label: string; disabled?: boolean; danger?: boolean; onSelect: () => void }> = [];

    if (entry) {
      patch(id, { selected: entry });
      if (entry.isDir) {
        items.push({ label: t("sftp.open"), onSelect: () => navigate(id, entry.path) });
      } else {
        items.push({ label: t("sftp.openWith"), onSelect: () => applyEntry(id, entry) });
      }
      items.push({ label: t("sftp.cut"), onSelect: () => cut(id, entry) });
      items.push({ label: t("sftp.copy"), onSelect: () => copy(id, entry) });
      items.push({
        label: t("sftp.paste"),
        disabled: !canPaste(clip, source, entry.isDir ? entry.path : directory),
        onSelect: () => pasteInto(id, entry.isDir ? entry.path : directory),
      });
      items.push({
        label: t(transferKey(source, panesRef.current[other(id)].source)),
        onSelect: () => transferSelected(id),
      });
      items.push({ label: t("sftp.rename"), onSelect: () => startRename(id, entry) });
      items.push({ label: t("sftp.copyPath"), onSelect: () => copyPath(entry) });
      items.push({ label: t("common.delete"), danger: true, onSelect: () => removeEntry(id, entry) });
    } else {
      items.push({ label: t("sftp.newFile"), onSelect: () => startCreate(id, "file") });
      items.push({ label: t("sftp.newFolder"), onSelect: () => startCreate(id, "folder") });
      items.push({
        label: t("sftp.paste"),
        disabled: !canPaste(clip, source, directory),
        onSelect: () => pasteInto(id, directory),
      });
      items.push({ label: t("sftp.refresh"), onSelect: () => void load(id, directory) });
    }
    openMenu(event.clientX, event.clientY, items);
  };

  const onKeyDown = (event: React.KeyboardEvent, id: PaneId) => {
    if (event.target instanceof HTMLInputElement) {
      return;
    }
    const state = panesRef.current[id].state;
    const entries = state.listing?.entries ?? [];
    const index = state.selected
      ? entries.findIndex((item) => item.path === state.selected?.path)
      : -1;
    const mod = event.ctrlKey || event.metaKey;

    if (mod) {
      const key = event.key.toLowerCase();
      if (key === "c" && state.selected) {
        event.preventDefault();
        copy(id, state.selected);
      } else if (key === "x" && state.selected) {
        event.preventDefault();
        cut(id, state.selected);
      } else if (key === "v") {
        event.preventDefault();
        pasteInto(id, state.listing?.path ?? "");
      }
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      selectAt(id, Math.min(entries.length - 1, index + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      selectAt(id, Math.max(0, index - 1));
    } else if (event.key === "Enter" && state.selected) {
      event.preventDefault();
      if (state.selected.isDir) {
        navigate(id, state.selected.path);
      } else {
        applyEntry(id, state.selected);
      }
    } else if (event.key === "Backspace" || (event.altKey && event.key === "ArrowLeft")) {
      event.preventDefault();
      if (state.listing) {
        navigate(id, parentOf(state.listing.path));
      }
    } else if (event.key === "F2" && state.selected) {
      event.preventDefault();
      startRename(id, state.selected);
    } else if (event.key === "Delete" && state.selected) {
      event.preventDefault();
      removeEntry(id, state.selected);
    } else if (event.key === "Escape") {
      patch(id, { creating: null, renaming: null });
    }
  };

  const chooseSource = (id: PaneId, value: string) => {
    const source: FsSource =
      value === "local" ? LOCAL_SOURCE : { kind: "remote", sessionId: value.slice("remote:".length) };
    setPanes((current) => ({ ...current, [id]: { source, state: EMPTY } }));
    void load(id, null, null, source);
    setActive(id);
  };

  if (!session) {
    return (
      <div className="page">
        <EmptyState
          icon={<StatusDot tone="warn" />}
          title={t("sftp.noSession")}
          action={
            host ? (
              <Button variant="primary" onClick={() => openConnect(host, "sftp")}>
                {t("terminal.connect")}
              </Button>
            ) : undefined
          }
        />
      </div>
    );
  }

  const renderPane = (id: PaneId) => {
    const model = panes[id];
    const state = model.state;
    const source = model.source;
    const entries = state.listing?.entries ?? [];
    const draft = state.draft ?? state.listing?.path ?? "";
    const renaming = state.renaming;
    const creating = state.creating;

    return (
      <section
        key={id}
        className={cn("sftp-pane", active === id && "is-active")}
        data-pane={id}
        onMouseDown={() => setActive(id)}
      >
        <header className="sftp-pane__head">
          <Select
            label={t("sftp.source")}
            value={sourceKey(source)}
            options={sourceOptions}
            onChange={(value) => chooseSource(id, value)}
          />
          <div className="sftp-pane__actions">
            <IconButton
              label={t("sftp.up")}
              size="sm"
              disabled={!state.listing}
              onClick={() => state.listing && navigate(id, parentOf(state.listing.path))}
            >
              <ArrowUp size={13} />
            </IconButton>
            <IconButton
              label={t("sftp.refresh")}
              size="sm"
              onClick={() =>
                void load(id, state.listing?.path ?? null, state.selected?.path ?? null)
              }
            >
              <RotateCw size={13} />
            </IconButton>
            <IconButton
              label={t("sftp.newFile")}
              size="sm"
              disabled={!state.listing}
              onClick={() => startCreate(id, "file")}
            >
              <FilePlus size={13} />
            </IconButton>
            <IconButton
              label={t("sftp.newFolder")}
              size="sm"
              disabled={!state.listing}
              onClick={() => startCreate(id, "folder")}
            >
              <FolderPlus size={13} />
            </IconButton>
            <IconButton
              label={t(transferKey(source, panes[other(id)].source))}
              size="sm"
              disabled={!state.selected || !panes[other(id)].state.listing}
              onClick={() => transferSelected(id)}
            >
              <ArrowLeftRight size={13} />
            </IconButton>
          </div>
        </header>

        <div className="sftp-pane__path">
          <Input
            value={draft}
            spellCheck={false}
            aria-label={t("sftp.path")}
            onChange={(event) => patch(id, { draft: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                navigate(id, draft.trim());
              }
            }}
          />
        </div>

        <div
          ref={(element) => {
            bodies.current[id] = element;
          }}
          className={cn(
            "sftp-pane__body",
            dropTarget?.pane === id && dropTarget.path === "" && "is-drop",
          )}
          tabIndex={0}
          role="listbox"
          aria-label={t("sftp.title")}
          onKeyDown={(event) => onKeyDown(event, id)}
          onContextMenu={(event) => {
            if (event.target === event.currentTarget) {
              openEntryMenu(event, id, null);
            }
          }}
          onDragOver={(event) => {
            if (!event.dataTransfer.types.includes("application/x-tunnelde-file")) {
              return;
            }
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            setDropTarget({ pane: id, path: "" });
          }}
          onDragLeave={() => setDropTarget(null)}
          onDrop={(event) => {
            event.preventDefault();
            const payload = readDragPayload(event.dataTransfer);
            setDropTarget(null);
            if (payload && state.listing) {
              handleDrop(id, state.listing.path, payload);
            }
          }}
        >
          {state.error ? <p className="sftp-pane__error">{state.error}</p> : null}
          {state.listing && entries.length === 0 && !creating ? (
            <p className="sftp-pane__empty">{t("sftp.empty")}</p>
          ) : null}

          {creating ? (
            <div className="sftp-row is-creating">
              <span className="sftp-row__icon">
                {creating.kind === "folder" ? <Folder size={13} /> : <FileIcon size={13} />}
              </span>
              <Input
                autoFocus
                className="sftp-row__name"
                value={creating.value}
                spellCheck={false}
                placeholder={
                  creating.kind === "folder" ? t("sftp.folderName") : t("sftp.fileName")
                }
                onChange={(event) =>
                  patch(id, { creating: { kind: creating.kind, value: event.target.value } })
                }
                onBlur={() => patch(id, { creating: null })}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void commitCreate(id);
                  }
                  if (event.key === "Escape") {
                    event.preventDefault();
                    patch(id, { creating: null });
                  }
                }}
              />
            </div>
          ) : null}

          {entries.map((entry) => (
            <div
              key={entry.path}
              role="option"
              aria-selected={state.selected?.path === entry.path}
              className={cn(
                "sftp-row",
                state.selected?.path === entry.path && "is-selected",
                dropTarget?.pane === id && dropTarget.path === entry.path && "is-drop",
                clip?.path === entry.path && "is-cut",
              )}
              draggable={renaming?.path !== entry.path}
              onDragStart={(event) =>
                setDragPayload(event.dataTransfer, {
                  source,
                  path: entry.path,
                  name: entry.name,
                  isDir: entry.isDir,
                })
              }
              onDragOver={(event) => {
                if (!entry.isDir) {
                  return;
                }
                event.preventDefault();
                event.stopPropagation();
                setDropTarget({ pane: id, path: entry.path });
              }}
              onDrop={(event) => {
                if (!entry.isDir) {
                  return;
                }
                event.preventDefault();
                event.stopPropagation();
                const payload = readDragPayload(event.dataTransfer);
                setDropTarget(null);
                if (payload) {
                  handleDrop(id, entry.path, payload);
                }
              }}
              onClick={() => revealRow(id, entry)}
              onDoubleClick={() => {
                if (entry.isDir) {
                  navigate(id, entry.path);
                } else {
                  applyEntry(id, entry);
                }
              }}
              onContextMenu={(event) => openEntryMenu(event, id, entry)}
            >
              <span className="sftp-row__icon">
                {entry.isDir ? <Folder size={13} /> : <FileIcon size={13} />}
              </span>
              {renaming?.path === entry.path ? (
                <Input
                  autoFocus
                  className="sftp-row__name"
                  value={renaming.value}
                  spellCheck={false}
                  onFocus={(event) => {
                    const dot = event.target.value.lastIndexOf(".");
                    event.target.setSelectionRange(0, dot > 0 ? dot : event.target.value.length);
                  }}
                  onChange={(event) =>
                    patch(id, { renaming: { path: entry.path, value: event.target.value } })
                  }
                  onBlur={() => patch(id, { renaming: null })}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void commitRename(id);
                    }
                    if (event.key === "Escape") {
                      event.preventDefault();
                      patch(id, { renaming: null });
                    }
                  }}
                />
              ) : (
                <span className="sftp-row__name" title={entry.name}>
                  {entry.name}
                </span>
              )}
              <span className="sftp-row__size">{entry.isDir ? "" : formatBytes(entry.size)}</span>
              <span className="sftp-row__time">
                {entry.modified ? formatDate(entry.modified, locale) : ""}
              </span>
            </div>
          ))}
        </div>

        <footer className="sftp-pane__foot">
          <span>{state.listing ? t("sftp.itemCount", { count: entries.length }) : "—"}</span>
          {state.selected ? (
            <span className="sftp-pane__selection">{state.selected.name}</span>
          ) : null}
        </footer>
      </section>
    );
  };

  return (
    <div className="sftp-page">
      <div className="sftp-panes">{PANE_IDS.map((id) => renderPane(id))}</div>

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
                <span className="transfer__name" title={item.name}>
                  {item.name}
                </span>
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
