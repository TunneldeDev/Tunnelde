// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import {
  ArrowLeftRight,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  File as FileIcon,
  FilePlus,
  Folder,
  FolderPlus,
  RotateCw,
  X,
} from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getCurrentWebview } from "@tauri-apps/api/webview";

import { EmptyState, StatusDot } from "@/components/ui/display/Misc";
import { Button, IconButton } from "@/components/ui/form/Button";
import { Input } from "@/components/ui/form/Field";
import { Select } from "@/components/ui/form/Select";
import { translateError } from "@/lib/api/errors";
import { isTauri } from "@/lib/api/ipc";
import type { FileEntry, FsSource, Listing } from "@/lib/api/types";
import {
  canPaste,
  DRAG_MIME,
  joinPath,
  parentOf,
  planPaste,
  readDragPayload,
  resolveDrop,
  setDragPayload,
  sameSource,
  separatorFor,
  validName,
  type DragPayload,
  type PasteClip,
} from "@/lib/files/dnd";
import { fs, LOCAL_SOURCE } from "@/lib/files/fs";
import { cn, formatBytes, formatDate } from "@/lib/text/format";
import { useContextMenu } from "@/store/contextMenu";
import { useDialogs } from "@/store/dialogs";
import { useFileClipboard } from "@/store/fileClipboard";
import { useSettings } from "@/store/settings";
import { useHosts } from "@/store/hosts";
import { useSsh } from "@/store/ssh";
import { toast } from "@/store/toasts";
import { useTransfers } from "@/store/transfers";
import { useWorkspace } from "@/store/workspace";

type PaneId = "a" | "b";

const PANE_IDS: PaneId[] = ["a", "b"];
const FILES_CHANGED = "tunnelde:files-changed";

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
  selectedPaths: string[];
  anchor: string | null;
  cursor: string | null;
  history: string[];
  historyIndex: number;
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
  selectedPaths: [],
  anchor: null,
  cursor: null,
  history: [],
  historyIndex: -1,
  busy: false,
  draft: null,
  renaming: null,
  creating: null,
};

function joinIn(source: FsSource, directory: string, name: string): string {
  return joinPath(directory, name, separatorFor(source, directory));
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
  const openMenu = useContextMenu((state) => state.open);

  const [panes, setPanes] = useState<Record<PaneId, PaneModel>>(() => ({
    a: { source: LOCAL_SOURCE, state: EMPTY },
    b: { source: { kind: "remote", sessionId }, state: EMPTY },
  }));
  const [active, setActive] = useState<PaneId>("a");
  const [dropTarget, setDropTarget] = useState<{ pane: PaneId; path: string } | null>(null);
  const [transferEpoch, setTransferEpoch] = useState(0);
  const instanceId = useId();
  const pageRef = useRef<HTMLDivElement>(null);
  const nativeDrop = useRef<(paths: string[], x: number, y: number) => void>(() => undefined);
  const panesRef = useRef(panes);
  const bodies = useRef<Record<PaneId, HTMLDivElement | null>>({ a: null, b: null });
  const pending = useRef(new Map<string, (() => void) | undefined>());
  const requests = useRef({ a: 0, b: 0 });
  const mounted = useRef(true);
  const mutations = useRef(new Set<PaneId>());
  const dragOrigin = useRef<PaneId | null>(null);

  useEffect(() => {
    mounted.current = true;
    const versions = requests.current;
    return () => {
      mounted.current = false;
      versions.a++;
      versions.b++;
    };
  }, []);

  const patch = useCallback((id: PaneId, next: Partial<PaneState>) => {
    if (!mounted.current) return;
    const current = panesRef.current;
    const updated = {
      ...current,
      [id]: { ...current[id], state: { ...current[id].state, ...next } },
    };
    panesRef.current = updated;
    setPanes(updated);
  }, []);

  const reveal = useCallback((id: PaneId, path?: string, editing = false) => {
    requestAnimationFrame(() => {
      const body = bodies.current[id];
      const wanted = path ?? panesRef.current[id].state.cursor;
      const row = Array.from(body?.querySelectorAll<HTMLElement>(".sftp-row") ?? []).find(
        (element) =>
          wanted ? element.dataset.path === wanted : element.classList.contains("is-creating"),
      );
      if (row && typeof row.scrollIntoView === "function") {
        row.scrollIntoView({ block: "nearest" });
      }
      if (editing) row?.querySelector<HTMLInputElement>("input")?.focus();
    });
  }, []);

  const cache = useRef(new Map<string, Listing>());
  const cacheGeneration = useRef(0);
  const inflight = useRef(new Set<string>());
  const cacheKey = (source: FsSource, path: string) =>
    `${source.kind === "local" ? "local" : `remote:${source.sessionId}`}|${path}`;
  const remember = useCallback((source: FsSource, listing: Listing) => {
    cache.current.set(cacheKey(source, listing.path), listing);
    if (cache.current.size > 64) {
      const oldest = cache.current.keys().next().value;
      if (oldest) {
        cache.current.delete(oldest);
      }
    }
  }, []);

  // Warm the parent and the first few child folders so moving around feels instant.
  const prefetch = useCallback(
    (source: FsSource, listing: Listing) => {
      if (!useSettings.getState().settings.preloadDirs) {
        return;
      }
      const count = useSettings.getState().settings.preloadCount;
      const targets = [
        parentOf(listing.path),
        ...listing.entries
          .filter((entry) => entry.isDir)
          .slice(0, count)
          .map((entry) => entry.path),
      ];
      for (const target of targets) {
        if (inflight.current.size >= 2) break;
        const key = cacheKey(source, target);
        if (cache.current.has(key) || inflight.current.has(key)) {
          continue;
        }
        inflight.current.add(key);
        const generation = cacheGeneration.current;
        void fs
          .list(source, target)
          .then((child) => {
            if (mounted.current && cacheGeneration.current === generation) remember(source, child);
          })
          .catch(() => undefined)
          .finally(() => inflight.current.delete(key));
      }
    },
    [remember],
  );

  const load = useCallback(
    async (
      id: PaneId,
      path?: string | null,
      keep?: string | null,
      override?: FsSource,
      historyIndex?: number,
    ): Promise<Listing | null> => {
      const source = override ?? panesRef.current[id].source;
      const version = ++requests.current[id];
      const cached = path ? cache.current.get(cacheKey(source, path)) : undefined;
      if (cached) {
        patch(id, { listing: cached, error: null, busy: true, draft: null });
      } else {
        patch(id, { busy: true, error: null });
      }
      try {
        const listing = await fs.list(source, path ?? null);
        if (
          !mounted.current ||
          requests.current[id] !== version ||
          !sameSource(source, panesRef.current[id].source)
        )
          return null;
        remember(source, listing);
        const current = panesRef.current[id].state;
        const history =
          historyIndex !== undefined
            ? current.history
            : current.history[current.historyIndex] === listing.path
              ? current.history
              : [...current.history.slice(0, current.historyIndex + 1), listing.path];
        const selected = keep ? listing.entries.find((item) => item.path === keep) : null;
        patch(id, {
          listing,
          selectedPaths: selected ? [selected.path] : [],
          anchor: selected?.path ?? null,
          cursor: selected?.path ?? null,
          history,
          historyIndex: historyIndex ?? history.length - 1,
          busy: false,
          draft: null,
        });
        if (selected) {
          reveal(id);
        }
        prefetch(source, listing);
        return listing;
      } catch (error) {
        if (!mounted.current || requests.current[id] !== version) return null;
        patch(id, { busy: false, error: translateError(error) });
        return null;
      }
    },
    [patch, prefetch, remember, reveal],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load("a");
      void load("b");
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  useEffect(() => {
    const onChanged = (event: Event) => {
      const { source, origin } = (event as CustomEvent<{ source: FsSource; origin: string }>)
        .detail;
      if (origin === instanceId) return;
      cacheGeneration.current++;
      cache.current.clear();
      for (const id of PANE_IDS) {
        if (sameSource(source, panesRef.current[id].source))
          void load(id, panesRef.current[id].state.listing?.path ?? null);
      }
    };
    window.addEventListener(FILES_CHANGED, onChanged);
    return () => window.removeEventListener(FILES_CHANGED, onChanged);
  }, [instanceId, load]);

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
      const next = { ...panesRef.current };
      for (const id of stale) next[id] = { source: LOCAL_SOURCE, state: EMPTY };
      panesRef.current = next;
      setPanes(next);
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
          const onDone = pending.current.get(item.id);
          pending.current.delete(item.id);
          if (item.status === "done") onDone?.();
          settled = true;
        }
      }
      if (!settled) {
        return;
      }
      for (const id of PANE_IDS) {
        cacheGeneration.current++;
        cache.current.clear();
        void load(id, panesRef.current[id].state.listing?.path ?? null);
        window.dispatchEvent(
          new CustomEvent(FILES_CHANGED, {
            detail: { source: panesRef.current[id].source, origin: instanceId },
          }),
        );
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [transfers, transferEpoch, load, instanceId]);

  // Several sessions can point at the same host; one row per host is enough.
  const canonicalSessions = useMemo(() => {
    const seen = new Set<string>();
    return sessions.filter((item) => {
      if (seen.has(item.hostId)) {
        return false;
      }
      seen.add(item.hostId);
      return true;
    });
  }, [sessions]);

  const sourceOptions = useMemo(
    () => [
      { value: "local", label: t("sftp.thisComputer") },
      ...canonicalSessions.map((item) => ({ value: `remote:${item.id}`, label: item.title })),
    ],
    [canonicalSessions, t],
  );

  const keyForSource = (source: FsSource): string => {
    if (source.kind === "local") {
      return "local";
    }
    const owner = sessions.find((item) => item.id === source.sessionId)?.hostId;
    const canonical = canonicalSessions.find((item) => item.hostId === owner);
    return `remote:${canonical?.id ?? source.sessionId}`;
  };

  const locale = i18n.resolvedLanguage ?? "en-US";
  const host = hosts.find((entry) => entry.id === session?.hostId) ?? null;

  const selectedEntries = (id: PaneId): FileEntry[] => {
    const state = panesRef.current[id].state;
    const chosen = new Set(state.selectedPaths);
    return (state.listing?.entries ?? []).filter((entry) => chosen.has(entry.path));
  };

  const primaryEntry = (id: PaneId): FileEntry | null => {
    const state = panesRef.current[id].state;
    const path = state.cursor ?? state.selectedPaths[state.selectedPaths.length - 1];
    return state.listing?.entries.find((entry) => entry.path === path) ?? null;
  };

  const selectEntry = (id: PaneId, entry: FileEntry, mode: "single" | "toggle" | "range") => {
    const state = panesRef.current[id].state;
    const entries = state.listing?.entries ?? [];
    let next: string[];
    if (mode === "range" && state.anchor) {
      const start = entries.findIndex((item) => item.path === state.anchor);
      const end = entries.findIndex((item) => item.path === entry.path);
      next =
        start >= 0 && end >= 0
          ? entries.slice(Math.min(start, end), Math.max(start, end) + 1).map((item) => item.path)
          : [entry.path];
    } else if (mode === "toggle") {
      next = state.selectedPaths.includes(entry.path)
        ? state.selectedPaths.filter((path) => path !== entry.path)
        : [...state.selectedPaths, entry.path];
    } else {
      next = [entry.path];
    }
    patch(id, {
      selectedPaths: next,
      cursor: entry.path,
      anchor: mode === "range" ? state.anchor : entry.path,
    });
    bodies.current[id]?.focus();
    reveal(id);
  };

  const selectAt = (id: PaneId, index: number, extend = false) => {
    const entries = panesRef.current[id].state.listing?.entries ?? [];
    const entry = entries[index];
    if (!entry) {
      return;
    }
    selectEntry(id, entry, extend ? "range" : "single");
  };

  const navigate = (id: PaneId, path: string) => {
    patch(id, { creating: null, renaming: null });
    void load(id, path);
  };

  const travel = (id: PaneId, delta: number) => {
    const state = panesRef.current[id].state;
    const index = state.historyIndex + delta;
    const path = state.history[index];
    if (path) void load(id, path, null, undefined, index);
  };

  const startTransfer = async (
    from: FsSource,
    fromPath: string,
    to: FsSource,
    toPath: string,
    move: boolean,
    onDone?: () => void,
    overwrite = false,
  ) => {
    try {
      const transferId = await fs.transfer(from, fromPath, to, toPath, move, overwrite);
      pending.current.set(transferId, onDone);
      if (mounted.current) setTransferEpoch((value) => value + 1);
    } catch (error) {
      toast(translateError(error), "error");
    }
  };

  const refreshSource = async (source: FsSource) => {
    cacheGeneration.current++;
    cache.current.clear();
    window.dispatchEvent(
      new CustomEvent(FILES_CHANGED, { detail: { source, origin: instanceId } }),
    );
    await Promise.all(
      PANE_IDS.filter((id) => sameSource(panesRef.current[id].source, source)).map((id) =>
        load(id, panesRef.current[id].state.listing?.path ?? null),
      ),
    );
  };

  const removeCutItem = (snapshot: PasteClip | null, path: string): PasteClip | null => {
    const current = useFileClipboard.getState().clip;
    if (!current || current !== snapshot) return null;
    const items = current.items.filter((item) => item.path !== path);
    const next = items.length ? { ...current, items } : null;
    useFileClipboard.getState().set(next);
    return next;
  };

  const approveTargets = async (
    target: FsSource,
    directory: string,
    ops: Array<{ from: string; to: string }>,
    run: (overwrite: boolean) => void,
  ) => {
    try {
      const listing = await fs.list(target, directory);
      const conflicts = listing.entries.filter((entry) => ops.some((op) => op.to === entry.path));
      if (conflicts.length) {
        confirm({
          title: t("sftp.overwriteTitle"),
          body: t("sftp.overwriteBody", {
            names: conflicts.map((entry) => entry.name).join(", "),
            path: directory,
          }),
          confirmLabel: t("sftp.overwrite"),
          danger: true,
          onConfirm: () => run(true),
        });
      } else run(false);
    } catch (error) {
      toast(translateError(error), "error");
    }
  };

  const runBatch = async (
    _id: PaneId,
    _directory: string,
    run: (source: FsSource, from: string, to: string, overwrite?: boolean) => Promise<void>,
    source: FsSource,
    ops: Array<{ from: string; to: string }>,
    overwrite = false,
    onDone?: (path: string) => void,
  ) => {
    try {
      for (const op of ops) {
        await run(source, op.from, op.to, overwrite);
        onDone?.(op.from);
      }
    } catch (error) {
      toast(translateError(error), "error");
    } finally {
      await refreshSource(source);
    }
  };

  const transferSelected = (id: PaneId) => {
    const entries = selectedEntries(id);
    const target = panesRef.current[other(id)];
    const directory = target.state.listing?.path;
    if (entries.length === 0 || !directory) {
      return;
    }
    const source = panesRef.current[id].source;
    const action = resolveDrop(
      { source, paneId: `${instanceId}:${id}`, items: entries },
      target.source,
      directory,
      `${instanceId}:${other(id)}`,
    );
    if (action.kind === "noop") return;
    void approveTargets(target.source, directory, action.ops, (overwrite) => {
      if (action.kind === "copy" || action.kind === "move") {
        void runBatch(other(id), directory, fs.copy, source, action.ops, overwrite);
      } else
        for (const op of action.ops)
          void startTransfer(source, op.from, target.source, op.to, false, undefined, overwrite);
    });
  };

  const clipSelection = (id: PaneId, action: "cut" | "copy") => {
    const entries = selectedEntries(id);
    if (entries.length === 0) {
      return;
    }
    setClip({
      source: panesRef.current[id].source,
      action,
      items: entries.map((entry) => ({
        path: entry.path,
        name: entry.name,
        isDir: entry.isDir,
      })),
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
    const snapshot = clip;
    void approveTargets(target, directory, action.ops, (overwrite) => {
      let remaining: PasteClip | null = snapshot;
      const done =
        snapshot.action === "cut"
          ? (path: string) => {
              remaining = removeCutItem(remaining, path);
            }
          : undefined;
      if (action.kind === "move" || action.kind === "copy") {
        void runBatch(
          id,
          directory,
          action.kind === "move" ? fs.rename : fs.copy,
          action.source,
          action.ops,
          overwrite,
          done,
        );
      } else
        for (const op of action.ops)
          void startTransfer(
            action.from,
            op.from,
            action.to,
            op.to,
            action.move,
            () => done?.(op.from),
            overwrite,
          );
    });
  };

  const handleDrop = (id: PaneId, directory: string, payload: DragPayload) => {
    const target = panesRef.current[id].source;
    const action = resolveDrop(payload, target, directory, `${instanceId}:${id}`);
    if (action.kind === "noop") {
      return;
    }
    void approveTargets(target, directory, action.ops, (overwrite) => {
      if (action.kind === "move" || action.kind === "copy") {
        void runBatch(
          id,
          directory,
          action.kind === "move" ? fs.rename : fs.copy,
          action.source,
          action.ops,
          overwrite,
        );
      } else
        for (const op of action.ops)
          void startTransfer(
            action.from,
            op.from,
            action.to,
            op.to,
            action.move,
            undefined,
            overwrite,
          );
    });
  };

  useEffect(() => {
    nativeDrop.current = (paths, x, y) => {
      const page = pageRef.current;
      if (!page || page.getClientRects().length === 0) return;
      const element = document.elementFromPoint(x, y);
      const paneElement = element?.closest<HTMLElement>("[data-pane]");
      if (!paneElement || !page.contains(paneElement)) return;
      const id = paneElement.dataset.pane as PaneId;
      const model = panesRef.current[id];
      if (!model || model.state.busy || !model.state.listing) return;
      const rowPath = element?.closest<HTMLElement>("[data-path]")?.dataset.path;
      const row = model.state.listing.entries.find((entry) => entry.path === rowPath);
      const directory = row?.isDir ? row.path : model.state.listing.path;
      void Promise.all(
        paths.map(async (path) => {
          const listing = await fs.list(LOCAL_SOURCE, parentOf(path));
          const entry = listing.entries.find((item) => item.path === path);
          if (!entry) throw new Error(t("error.notFound"));
          return entry;
        }),
      )
        .then((items) => {
          const current = panesRef.current[id];
          if (
            sameSource(model.source, current.source) &&
            current.state.listing?.path === model.state.listing?.path
          )
            handleDrop(id, directory, { source: LOCAL_SOURCE, paneId: "external", items });
        })
        .catch((error: unknown) => toast(translateError(error), "error"));
    };
  });

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let cleanup: (() => void) | undefined;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type !== "drop") return;
        const scale = window.devicePixelRatio || 1;
        nativeDrop.current(
          event.payload.paths,
          event.payload.position.x / scale,
          event.payload.position.y / scale,
        );
      })
      .then((unlisten) => {
        if (disposed) unlisten();
        else cleanup = unlisten;
      })
      .catch((error: unknown) => toast(translateError(error), "error"));
    return () => {
      disposed = true;
      cleanup?.();
    };
  }, []);

  const startRename = (id: PaneId, entry: FileEntry) => {
    if (panesRef.current[id].state.busy) return;
    patch(id, {
      selectedPaths: [entry.path],
      anchor: entry.path,
      cursor: entry.path,
      creating: null,
      error: null,
      renaming: { path: entry.path, value: entry.name },
    });
    reveal(id, entry.path, true);
  };

  const commitRename = async (id: PaneId) => {
    const state = panesRef.current[id].state;
    const source = panesRef.current[id].source;
    const renaming = state.renaming;
    if (!renaming || mutations.current.has(id)) {
      return;
    }
    const name = renaming.value.trim();
    const entry = state.listing?.entries.find((item) => item.path === renaming.path);
    if (!entry || !name || name === entry.name) {
      patch(id, { renaming: null });
      return;
    }
    if (!validName(name, source, state.listing?.path ?? "")) {
      patch(id, { error: t("sftp.invalidName") });
      return;
    }
    if (state.listing?.entries.some((item) => item.name === name && item.path !== entry.path)) {
      patch(id, { error: t("sftp.alreadyExists") });
      return;
    }
    const target = joinIn(source, parentOf(entry.path), name);
    mutations.current.add(id);
    patch(id, { busy: true });
    try {
      await fs.rename(source, entry.path, target);
      patch(id, { renaming: null });
      await refreshSource(source);
      if (
        !sameSource(source, panesRef.current[id].source) ||
        panesRef.current[id].state.listing?.path !== state.listing?.path
      )
        return;
      patch(id, { selectedPaths: [target], cursor: target, anchor: target });
      reveal(id, target);
      bodies.current[id]?.focus();
    } catch (error) {
      if (sameSource(source, panesRef.current[id].source))
        patch(id, { error: translateError(error), busy: false });
    } finally {
      mutations.current.delete(id);
    }
  };

  const startCreate = (id: PaneId, kind: "file" | "folder") => {
    if (!panesRef.current[id].state.listing || panesRef.current[id].state.busy) return;
    patch(id, { creating: { kind, value: "" }, renaming: null, error: null });
    reveal(id, undefined, true);
  };

  const commitCreate = async (id: PaneId) => {
    const state = panesRef.current[id].state;
    const source = panesRef.current[id].source;
    const creating = state.creating;
    const directory = state.listing?.path;
    if (!creating || !directory || mutations.current.has(id)) {
      return;
    }
    const name = creating.value.trim();
    if (!name) {
      patch(id, { creating: null });
      return;
    }
    if (!validName(name, source, directory)) {
      patch(id, { error: t("sftp.invalidName") });
      return;
    }
    if (state.listing?.entries.some((item) => item.name === name)) {
      patch(id, { error: t("sftp.alreadyExists") });
      return;
    }
    const target = joinIn(source, directory, name);
    mutations.current.add(id);
    patch(id, { busy: true });
    try {
      if (creating.kind === "folder") {
        await fs.mkdir(source, target);
      } else {
        await fs.createFile(source, target);
      }
      patch(id, { creating: null });
      await refreshSource(source);
      if (
        !sameSource(source, panesRef.current[id].source) ||
        panesRef.current[id].state.listing?.path !== directory
      )
        return;
      patch(id, { selectedPaths: [target], cursor: target, anchor: target });
      reveal(id, target);
      bodies.current[id]?.focus();
    } catch (error) {
      if (sameSource(source, panesRef.current[id].source))
        patch(id, { error: translateError(error), busy: false });
    } finally {
      mutations.current.delete(id);
    }
  };

  const removeSelection = (id: PaneId) => {
    const source = panesRef.current[id].source;
    const entries = selectedEntries(id);
    if (entries.length === 0) {
      return;
    }
    const single = entries.length === 1 ? entries[0] : null;
    confirm({
      title: t("sftp.deleteTitle"),
      body: single
        ? t("sftp.deleteBody", { name: single.name })
        : t("sftp.deleteManyBody", { count: entries.length }),
      confirmLabel: t("common.delete"),
      danger: true,
      onConfirm: async () => {
        try {
          for (const entry of entries) {
            await fs.remove(source, entry.path, entry.isDir);
          }
        } catch (error) {
          toast(translateError(error), "error");
        } finally {
          await refreshSource(source);
        }
      },
    });
  };

  const applyEntry = (id: PaneId, entry: FileEntry) => {
    const source = panesRef.current[id].source;
    if (source.kind === "local") {
      void fs
        .openLocal(entry.path)
        .catch((error: unknown) => toast(translateError(error), "error"));
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
    event.stopPropagation();
    if (panesRef.current[id].state.busy) return;
    const source = panesRef.current[id].source;
    const directory = panesRef.current[id].state.listing?.path ?? "";
    const items: Array<{
      label: string;
      disabled?: boolean;
      danger?: boolean;
      onSelect: () => void;
    }> = [];

    if (entry) {
      if (!panesRef.current[id].state.selectedPaths.includes(entry.path)) {
        patch(id, { selectedPaths: [entry.path], anchor: entry.path });
      }
      if (entry.isDir) {
        items.push({ label: t("sftp.open"), onSelect: () => navigate(id, entry.path) });
      } else {
        items.push({
          label: t(source.kind === "local" ? "sftp.openWith" : "sftp.edit"),
          onSelect: () => applyEntry(id, entry),
        });
      }
      items.push({ label: t("sftp.cut"), onSelect: () => clipSelection(id, "cut") });
      items.push({ label: t("sftp.copy"), onSelect: () => clipSelection(id, "copy") });
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
      items.push({ label: t("common.delete"), danger: true, onSelect: () => removeSelection(id) });
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
    const primary = primaryEntry(id);
    const index = primary ? entries.findIndex((item) => item.path === primary.path) : -1;
    const mod = event.ctrlKey || event.metaKey;

    if (event.altKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      event.preventDefault();
      event.stopPropagation();
      travel(id, event.key === "ArrowLeft" ? -1 : 1);
      return;
    }
    if (event.key === "F5") {
      event.preventDefault();
      event.stopPropagation();
      void load(id, state.listing?.path ?? null, state.cursor);
      return;
    }
    if (state.busy) return;

    if (mod) {
      const key = event.key.toLowerCase();
      if (key === "a") {
        event.preventDefault();
        patch(id, {
          selectedPaths: entries.map((item) => item.path),
          anchor: entries[0]?.path ?? null,
          cursor: entries[entries.length - 1]?.path ?? null,
        });
      } else if (key === "c" && state.selectedPaths.length > 0) {
        event.preventDefault();
        clipSelection(id, "copy");
      } else if (key === "x" && state.selectedPaths.length > 0) {
        event.preventDefault();
        clipSelection(id, "cut");
      } else if (key === "v") {
        event.preventDefault();
        pasteInto(id, state.listing?.path ?? "");
      } else if (key === "n") {
        event.preventDefault();
        startCreate(id, event.shiftKey ? "folder" : "file");
      }
      if (event.defaultPrevented) event.stopPropagation();
      return;
    }

    if (event.key === "ArrowDown") {
      event.preventDefault();
      selectAt(id, Math.min(entries.length - 1, index + 1), event.shiftKey);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      selectAt(id, Math.max(0, index - 1), event.shiftKey);
    } else if (event.key === "Enter" && primary) {
      event.preventDefault();
      if (primary.isDir) {
        navigate(id, primary.path);
      } else {
        applyEntry(id, primary);
      }
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      selectAt(id, event.key === "Home" ? 0 : entries.length - 1, event.shiftKey);
    } else if (event.key === "Backspace" || (event.altKey && event.key === "ArrowUp")) {
      event.preventDefault();
      if (state.listing) {
        navigate(id, parentOf(state.listing.path));
      }
    } else if (event.key === "F2" && primary && state.selectedPaths.length === 1) {
      event.preventDefault();
      startRename(id, primary);
    } else if (event.key === "Delete" && state.selectedPaths.length > 0) {
      event.preventDefault();
      removeSelection(id);
    } else if (event.key === "Escape") {
      patch(id, { creating: null, renaming: null, selectedPaths: [], anchor: null, cursor: null });
    }
  };

  const chooseSource = (id: PaneId, value: string) => {
    const source: FsSource =
      value === "local"
        ? LOCAL_SOURCE
        : { kind: "remote", sessionId: value.slice("remote:".length) };
    const next = { ...panesRef.current, [id]: { source, state: EMPTY } };
    panesRef.current = next;
    setPanes(next);
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
    const selectedSet = new Set(state.selectedPaths);
    const cutSet =
      clip?.action === "cut" && sameSource(clip.source, source)
        ? new Set(clip.items.map((item) => item.path))
        : new Set<string>();
    const primary =
      entries.find(
        (item) =>
          item.path === (state.cursor ?? state.selectedPaths[state.selectedPaths.length - 1]),
      ) ?? null;

    return (
      <section
        key={id}
        className={cn("sftp-pane", active === id && "is-active")}
        data-pane={id}
        onMouseDown={() => setActive(id)}
        onKeyDownCapture={(event) => {
          if (
            (event.ctrlKey || event.metaKey) &&
            !event.altKey &&
            !event.shiftKey &&
            event.key.toLowerCase() === "l" &&
            !event.nativeEvent.isComposing
          ) {
            event.preventDefault();
            event.stopPropagation();
            setActive(id);
            const path =
              event.currentTarget.querySelector<HTMLInputElement>(".sftp-pane__path input");
            path?.focus();
            path?.select();
          }
        }}
      >
        <header className="sftp-pane__head">
          <Select
            label={t("sftp.source")}
            value={keyForSource(source)}
            options={sourceOptions}
            onChange={(value) => chooseSource(id, value)}
          />
          <div className="sftp-pane__actions">
            <IconButton
              label={t("sftp.back")}
              size="sm"
              disabled={state.historyIndex <= 0 || state.busy}
              onClick={() => travel(id, -1)}
            >
              <ArrowLeft size={13} />
            </IconButton>
            <IconButton
              label={t("sftp.forward")}
              size="sm"
              disabled={state.historyIndex >= state.history.length - 1 || state.busy}
              onClick={() => travel(id, 1)}
            >
              <ArrowRight size={13} />
            </IconButton>
            <IconButton
              label={t("sftp.up")}
              size="sm"
              disabled={
                !state.listing || state.busy || parentOf(state.listing.path) === state.listing.path
              }
              onClick={() => state.listing && navigate(id, parentOf(state.listing.path))}
            >
              <ArrowUp size={13} />
            </IconButton>
            <IconButton
              label={t("sftp.refresh")}
              size="sm"
              onClick={() =>
                void load(
                  id,
                  state.listing?.path ?? null,
                  state.selectedPaths[state.selectedPaths.length - 1] ?? null,
                )
              }
            >
              <RotateCw size={13} />
            </IconButton>
            <IconButton
              label={t("sftp.newFile")}
              size="sm"
              disabled={!state.listing || state.busy}
              onClick={() => startCreate(id, "file")}
            >
              <FilePlus size={13} />
            </IconButton>
            <IconButton
              label={t("sftp.newFolder")}
              size="sm"
              disabled={!state.listing || state.busy}
              onClick={() => startCreate(id, "folder")}
            >
              <FolderPlus size={13} />
            </IconButton>
            <IconButton
              label={t(transferKey(source, panes[other(id)].source))}
              size="sm"
              disabled={
                state.busy ||
                panes[other(id)].state.busy ||
                state.selectedPaths.length === 0 ||
                !panes[other(id)].state.listing
              }
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
          aria-multiselectable="true"
          aria-busy={state.busy}
          aria-label={t("sftp.title")}
          aria-activedescendant={
            primary
              ? `${instanceId}-${id}-row-${entries.findIndex((item) => item.path === primary.path)}`
              : undefined
          }
          onKeyDown={(event) => onKeyDown(event, id)}
          onContextMenu={(event) => {
            if (!(event.target as HTMLElement).closest(".sftp-row")) {
              openEntryMenu(event, id, null);
            }
          }}
          onDragOver={(event) => {
            if (state.busy || !event.dataTransfer.types.includes(DRAG_MIME)) {
              return;
            }
            event.preventDefault();
            event.dataTransfer.dropEffect = dragOrigin.current === id ? "move" : "copy";
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
          {state.busy ? (
            <p className="sftp-pane__empty" role="status">
              {t("sftp.loading")}
            </p>
          ) : null}
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
                placeholder={creating.kind === "folder" ? t("sftp.folderName") : t("sftp.fileName")}
                onChange={(event) =>
                  patch(id, { creating: { kind: creating.kind, value: event.target.value } })
                }
                onBlur={() => patch(id, { creating: null })}
                onClick={(event) => event.stopPropagation()}
                onDoubleClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (event.nativeEvent.isComposing) return;
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

          {entries.map((entry, position) => (
            <div
              key={entry.path}
              id={`${instanceId}-${id}-row-${position}`}
              data-path={entry.path}
              role="option"
              aria-selected={selectedSet.has(entry.path)}
              className={cn(
                "sftp-row",
                selectedSet.has(entry.path) && "is-selected",
                dropTarget?.pane === id && dropTarget.path === entry.path && "is-drop",
                cutSet.has(entry.path) && "is-cut",
              )}
              draggable={!state.busy && renaming?.path !== entry.path}
              onDragStart={(event) => {
                dragOrigin.current = id;
                const chosen = selectedEntries(id);
                const items = chosen.some((item) => item.path === entry.path) ? chosen : [entry];
                if (!chosen.some((item) => item.path === entry.path)) {
                  patch(id, { selectedPaths: [entry.path], anchor: entry.path });
                }
                setDragPayload(event.dataTransfer, {
                  source,
                  paneId: `${instanceId}:${id}`,
                  items: items.map((item) => ({
                    path: item.path,
                    name: item.name,
                    isDir: item.isDir,
                  })),
                });
              }}
              onDragEnd={() => {
                dragOrigin.current = null;
                setDropTarget(null);
              }}
              onDragOver={(event) => {
                if (state.busy || !entry.isDir || !event.dataTransfer.types.includes(DRAG_MIME)) {
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
              onClick={(event) => {
                if (state.busy || renaming?.path === entry.path) return;
                const mode = event.shiftKey
                  ? "range"
                  : event.ctrlKey || event.metaKey
                    ? "toggle"
                    : "single";
                selectEntry(id, entry, mode);
              }}
              onDoubleClick={() => {
                if (state.busy || renaming?.path === entry.path) return;
                if (entry.isDir) {
                  navigate(id, entry.path);
                } else {
                  applyEntry(id, entry);
                }
              }}
              onContextMenu={(event) => openEntryMenu(event, id, entry)}
            >
              <span className={cn("sftp-row__icon", entry.isDir && "is-dir")}>
                {entry.isDir ? <Folder size={13} /> : <FileIcon size={13} />}
              </span>
              {renaming?.path === entry.path ? (
                <Input
                  autoFocus
                  className="sftp-row__name"
                  value={renaming.value}
                  spellCheck={false}
                  onFocus={(event) => {
                    const dot = entry.isDir ? -1 : event.target.value.lastIndexOf(".");
                    event.target.setSelectionRange(0, dot > 0 ? dot : event.target.value.length);
                  }}
                  onChange={(event) =>
                    patch(id, { renaming: { path: entry.path, value: event.target.value } })
                  }
                  onBlur={() => patch(id, { renaming: null })}
                  onClick={(event) => event.stopPropagation()}
                  onDoubleClick={(event) => event.stopPropagation()}
                  onKeyDown={(event) => {
                    event.stopPropagation();
                    if (event.nativeEvent.isComposing) return;
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
          {state.selectedPaths.length > 1 ? (
            <span className="sftp-pane__selection">
              {t("sftp.selectedCount", { count: state.selectedPaths.length })}
            </span>
          ) : primary ? (
            <span className="sftp-pane__selection">{primary.name}</span>
          ) : null}
        </footer>
      </section>
    );
  };

  return (
    <div className="sftp-page" ref={pageRef}>
      <div className="sftp-panes">{PANE_IDS.map((id) => renderPane(id))}</div>

      {transfers.length > 0 ? (
        <footer className="sftp-transfers">
          {transfers.map((item) => {
            const percent =
              item.total > 0 ? Math.min(100, Math.round((item.transferred / item.total) * 100)) : 0;
            const stateLabel =
              item.status === "running"
                ? item.cancelling
                  ? t("sftp.cancelling")
                  : `${percent}%`
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
                    disabled={item.cancelling}
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
