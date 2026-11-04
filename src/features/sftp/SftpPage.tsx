import { matchesCommand, isTextTarget } from "@/lib/keyboard/registry";
import {
  ArrowLeftRight,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Eye,
  ChevronRight,
  Search,
  File as FileIcon,
  FilePlus,
  Folder,
  FolderPlus,
  RotateCw,
  X,
  PanelRightOpen,
} from "lucide-react";
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getCurrentWebview } from "@tauri-apps/api/webview";

import { EmptyState, StatusDot } from "@/components/ui/display/Misc";
import { Button, IconButton } from "@/components/ui/form/Button";
import { Input } from "@/components/ui/form/Field";
import { Select } from "@/components/ui/form/Select";
import { FileViewMenu } from "./FileViewMenu";
import { FilePathBar } from "./FilePathBar";
import { FileRemoteDialog } from "./FileRemoteDialog";
import { FileTypeSelect } from "./FileTypeSelect";
import { FileTransfers } from "./FileTransfers";
import { FileSplitView } from "./FileSplitView";
import { typeSelect, type TypeSelectState } from "@/lib/files/typeSelect";
import { columnAncestors } from "@/lib/files/navigation";
import { domainEvents, type FilesChanged } from "@/lib/events/domain";
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
import { fs, LOCAL_SOURCE, sourceKey } from "@/lib/files/fs";
import { createPrefetchQueue } from "@/lib/files/prefetch";
import {
  createGroupedFileViewSelector,
  fileExtension,
  visibleFiles,
  type FileViewPreferences,
  type FileKindFilter,
} from "@/lib/files/view";
import {
  fileViewPreferenceKey,
  readFileViewPreferences,
  writeFileViewPreferences,
} from "@/lib/files/preferences";
import { copyText } from "@/lib/session/clipboard";
import { cn, formatBytes } from "@/lib/text/format";
import { useContextMenu } from "@/store/contextMenu";
import { useDialogs } from "@/store/dialogs";
import { useFileClipboard } from "@/store/fileClipboard";
import { useSettings } from "@/store/settings";
import { useHosts } from "@/store/hosts";
import { useSsh } from "@/store/ssh";
import { toast } from "@/store/toasts";
import { useTransfers } from "@/store/transfers";
import { useWorkspace, type FilePaneOptions } from "@/store/workspace";
import { useSearchRoots } from "@/store/searchRoots";
import { useFilePreview } from "@/store/filePreview";

type PaneId = "a" | "b";

const PANE_IDS: PaneId[] = ["a", "b"];
const SINGLE_PANE_IDS: PaneId[] = ["a"];

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
  ancestors: Listing[];
  pathEditing: boolean;
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
  revealedPaths: string[];
  filterOpen: boolean;
  filter: string;
  filterKind: FileKindFilter;
  collapsedGroups: string[];
}

interface PaneModel {
  source: FsSource;
  state: PaneState;
  view: FileViewPreferences;
}

const EMPTY: PaneState = {
  listing: null,
  ancestors: [],
  pathEditing: false,
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
  revealedPaths: [],
  filterOpen: false,
  filter: "",
  filterKind: "all",
  collapsedGroups: [],
};
const NO_ENTRIES: FileEntry[] = [];

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

export function SftpPage({
  sessionId,
  single,
  scopeId,
}: {
  sessionId: string;
  single?: FilePaneOptions;
  scopeId?: string;
}) {
  const { t, i18n } = useTranslation();
  const visiblePaneIds = single ? SINGLE_PANE_IDS : PANE_IDS;
  const session = useSsh((state) => state.sessions.find((item) => item.id === sessionId) ?? null);
  const sessions = useSsh((state) => state.sessions);
  const confirm = useDialogs((state) => state.confirm);
  const openConnect = useDialogs((state) => state.openConnect);
  const openEditor = useWorkspace((state) => state.openEditor);
  const hosts = useHosts((state) => state.hosts);
  const transferChanges = useTransfers((state) =>
    state.items.map((item) => `${item.id}:${item.status}:${item.durable}`).join(","),
  );
  useEffect(() => {
    void useTransfers.getState().hydrate();
  }, []);
  const pendingTransferIds = useTransfers((state) =>
    state.items
      .filter((x) => !x.durable && x.status === "running")
      .map((x) => x.id)
      .join(","),
  );
  useEffect(() => {
    if (pendingTransferIds) void useTransfers.getState().hydrate();
  }, [pendingTransferIds]);
  const clip = useFileClipboard((state) => state.clip);
  const setClip = useFileClipboard((state) => state.set);
  const openMenu = useContextMenu((state) => state.open);
  const settings = useSettings((state) => state.settings);
  const [preferenceCache] = useState(() => new Map<string, FileViewPreferences>());
  const preferenceKey = useCallback(
    (id: PaneId, source: FsSource) => {
      const currentSessions = useSsh.getState().sessions;
      const ownerFor = (remoteId: string) => {
        const hostId = currentSessions.find((item) => item.id === remoteId)?.hostId;
        return hostId ? `host:${hostId}` : `session:${remoteId}`;
      };
      let windowLabel = "main";
      try {
        if (isTauri()) windowLabel = getCurrentWebview().label;
      } catch {
        /* Browser preview. */
      }
      return fileViewPreferenceKey(
        windowLabel,
        scopeId ?? ownerFor(sessionId),
        id,
        source.kind === "local" ? "local" : ownerFor(source.sessionId),
      );
    },
    [sessionId, scopeId],
  );
  const preferencesFor = useCallback(
    (id: PaneId, source: FsSource) => {
      const key = preferenceKey(id, source);
      let value = preferenceCache.get(key);
      if (!value) {
        const defaults = useSettings.getState().settings;
        value = readFileViewPreferences(key, {
          filesShowHidden: defaults.filesShowHidden,
          filesFoldersFirst: defaults.filesFoldersFirst,
          filesSortBy: defaults.filesSortBy,
          filesSortDirection: defaults.filesSortDirection,
        });
        preferenceCache.set(key, value);
      }
      return value;
    },
    [preferenceKey, preferenceCache],
  );
  const locale = i18n.resolvedLanguage ?? "en-US";
  const dateFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: "medium" }),
    [locale],
  );
  const collator = useMemo(
    () => new Intl.Collator(locale, { numeric: true, sensitivity: "base" }),
    [locale],
  );
  const prefetchCollator = useRef(collator);
  useEffect(() => {
    prefetchCollator.current = collator;
  }, [collator]);
  const viewSelectors = useMemo(
    () => ({ a: createGroupedFileViewSelector(), b: createGroupedFileViewSelector() }),
    [],
  );

  const [panes, setPanes] = useState<Record<PaneId, PaneModel>>(() => ({
    a: {
      source: single?.source ?? LOCAL_SOURCE,
      state: EMPTY,
      view: single?.view ?? preferencesFor("a", single?.source ?? LOCAL_SOURCE),
    },
    b: {
      source: { kind: "remote", sessionId },
      state: EMPTY,
      view: preferencesFor("b", { kind: "remote", sessionId }),
    },
  }));
  const [active, setActive] = useState<PaneId>("a");
  const [remotePane, setRemotePane] = useState<PaneId | null>(null);
  const [dropTarget, setDropTarget] = useState<{ pane: PaneId; path: string } | null>(null);
  const [transferEpoch, setTransferEpoch] = useState(0);
  const instanceId = useId();
  useEffect(() => {
    useSearchRoots.getState().publish(
      instanceId,
      [active, other(active)].flatMap((id) => {
        const pane = panes[id];
        return pane.state.listing
          ? [
              {
                id: `${instanceId}:${id}`,
                tabId: `sftp:${sessionId}`,
                path: pane.state.listing.path,
                sessionId: pane.source.kind === "remote" ? pane.source.sessionId : null,
              },
            ]
          : [];
      }),
    );
  }, [instanceId, active, panes, sessionId]);
  useEffect(() => () => useSearchRoots.getState().remove(instanceId), [instanceId]);
  const pageRef = useRef<HTMLDivElement>(null);
  const nativeDrop = useRef<(paths: string[], x: number, y: number) => void>(() => undefined);
  const panesRef = useRef(panes);
  const bodies = useRef<Record<PaneId, HTMLDivElement | null>>({ a: null, b: null });
  const columnScroll = useRef(new Map<string, number>());
  const pending = useRef(new Map<string, (() => void) | undefined>());
  const requests = useRef({ a: 0, b: 0 });
  // A refresh must follow an in-flight navigation, whose listing can still show the old path.
  const requested = useRef<Record<PaneId, { path: string | null; historyIndex?: number }>>({
    a: { path: null },
    b: { path: null },
  });
  const mounted = useRef(true);
  const mutations = useRef(new Set<PaneId>());
  const dragOrigin = useRef<PaneId | null>(null);
  const typeSelectState = useRef<Partial<Record<PaneId, TypeSelectState>>>({});

  const rememberColumnScroll = (id: PaneId, path: string, top: number) => {
    const key = `${id}:${sourceKey(panesRef.current[id].source)}:${path}`;
    columnScroll.current.delete(key);
    columnScroll.current.set(key, top);
    if (columnScroll.current.size > 128)
      columnScroll.current.delete(columnScroll.current.keys().next().value!);
  };

  useEffect(() => {
    for (const id of visiblePaneIds) {
      const body = bodies.current[id];
      const columns = body?.closest<HTMLElement>(".sftp-miller");
      if (!columns) continue;
      columns.scrollLeft = columns.scrollWidth;
      for (const list of columns.querySelectorAll<HTMLElement>("[data-column-path]")) {
        list.scrollTop =
          columnScroll.current.get(
            `${id}:${sourceKey(panesRef.current[id].source)}:${list.dataset.columnPath}`,
          ) ?? 0;
      }
    }
  }, [
    panes.a.state.listing?.path,
    panes.b.state.listing?.path,
    panes.a.view.filesLayout,
    panes.b.view.filesLayout,
    visiblePaneIds,
  ]);

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
      const wanted = path ?? (editing ? null : panesRef.current[id].state.cursor);
      const row = Array.from(body?.querySelectorAll<HTMLElement>(".sftp-row") ?? []).find(
        (element) =>
          wanted ? element.dataset.path === wanted : element.classList.contains("is-creating"),
      );
      if (row && typeof row.scrollIntoView === "function") {
        row.scrollIntoView({ block: "nearest", inline: "nearest" });
      }
      if (editing) row?.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true });
    });
  }, []);

  const cache = useRef(new Map<string, Listing>());
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

  const preloader = useRef<ReturnType<typeof createPrefetchQueue<Listing>> | null>(null);
  useEffect(() => {
    const queue = createPrefetchQueue<Listing>({
      enabled: () => useSettings.getState().settings.preloadDirs,
      cached: (key) => cache.current.has(key),
    });
    preloader.current = queue;
    return () => {
      queue.invalidate();
      preloader.current = null;
    };
  }, []);

  // Warm the parent and the first few child folders so moving around feels instant.
  const prefetch = useCallback(
    (id: PaneId, source: FsSource, listing: Listing) => {
      if (!useSettings.getState().settings.preloadDirs) {
        return;
      }
      const preferences = useSettings.getState().settings;
      const count = preferences.preloadCount;
      const targets = [
        parentOf(listing.path),
        ...viewSelectors[id](
          listing.entries,
          panesRef.current[id].view,
          prefetchCollator.current,
          panesRef.current[id].state.revealedPaths,
          { query: panesRef.current[id].state.filter, kind: panesRef.current[id].state.filterKind },
          panesRef.current[id].state.collapsedGroups,
        )
          .entries.filter((entry) => entry.isDir)
          .slice(0, count)
          .map((entry) => entry.path),
      ];
      preloader.current?.replace(
        id,
        [...new Set(targets)].map((target) => ({
          key: cacheKey(source, target),
          read: () => fs.list(source, target),
          commit: (child) => remember(source, child),
        })),
      );
    },
    [preloader, remember, viewSelectors],
  );

  useEffect(() => {
    if (!settings.preloadDirs) {
      preloader.current?.invalidate();
      return;
    }
    for (const id of visiblePaneIds) {
      const pane = panesRef.current[id];
      if (pane.state.listing && !pane.state.busy) prefetch(id, pane.source, pane.state.listing);
    }
  }, [settings.preloadDirs, settings.preloadCount, collator, prefetch, preloader, visiblePaneIds]);

  const load = useCallback(
    async (
      id: PaneId,
      path?: string | null,
      keep?: string | null,
      override?: FsSource,
      historyIndex?: number,
    ): Promise<Listing | null> => {
      const source = override ?? panesRef.current[id].source;
      const previousListing = panesRef.current[id].state.listing;
      const previousAncestors = panesRef.current[id].state.ancestors;
      const previousPath = panesRef.current[id].state.listing?.path;
      const destination = path ?? null;
      const targetHistoryIndex =
        historyIndex ??
        (panesRef.current[id].state.busy && requested.current[id].path === destination
          ? requested.current[id].historyIndex
          : undefined);
      requested.current[id] = { path: destination, historyIndex: targetHistoryIndex };
      const version = ++requests.current[id];
      const release = preloader.current?.foreground(id, path ? cacheKey(source, path) : undefined);
      const cached = path ? cache.current.get(cacheKey(source, path)) : undefined;
      if (cached) {
        patch(id, {
          listing: cached,
          ancestors: columnAncestors(previousAncestors, previousListing, cached),
          error: null,
          busy: true,
          draft: null,
        });
      } else {
        patch(id, { busy: true, error: null });
      }
      try {
        const listing = await fs.list(source, path ?? null);
        const ancestors = columnAncestors(previousAncestors, previousListing, listing);
        // Refresh visible parent columns after mutations or an explicit refresh.
        if (
          panesRef.current[id].view.filesLayout === "columns" &&
          previousPath === listing.path &&
          ancestors.length
        ) {
          const refreshed = await Promise.allSettled(
            ancestors.map((item) => fs.list(source, item.path)),
          );
          refreshed.forEach((result, index) => {
            if (result.status === "fulfilled") ancestors[index] = result.value;
          });
        }
        if (
          !mounted.current ||
          requests.current[id] !== version ||
          !sameSource(source, panesRef.current[id].source)
        )
          return null;
        remember(source, listing);
        requested.current[id] = { path: listing.path };
        const current = panesRef.current[id].state;
        const history =
          targetHistoryIndex !== undefined
            ? current.history
            : current.history[current.historyIndex] === listing.path
              ? current.history
              : [...current.history.slice(0, current.historyIndex + 1), listing.path];
        const selected = keep ? listing.entries.find((item) => item.path === keep) : null;
        patch(id, {
          listing,
          ancestors,
          selectedPaths: selected ? [selected.path] : [],
          anchor: selected?.path ?? null,
          cursor: selected?.path ?? null,
          history,
          historyIndex: targetHistoryIndex ?? history.length - 1,
          busy: false,
          draft: null,
          revealedPaths: previousPath === listing.path ? current.revealedPaths : [],
          ...(previousPath !== listing.path
            ? { filter: "", filterKind: "all" as const, collapsedGroups: [] }
            : {}),
        });
        if (selected) {
          reveal(id);
        }
        prefetch(id, source, listing);
        return listing;
      } catch (error) {
        if (!mounted.current || requests.current[id] !== version) return null;
        requested.current[id] = { path: panesRef.current[id].state.listing?.path ?? null };
        patch(id, { busy: false, error: translateError(error) });
        return null;
      } finally {
        release?.();
      }
    },
    [cache, patch, prefetch, preloader, remember, reveal],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load("a", single?.path);
      if (!single) void load("b");
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load, single]);

  useEffect(() => {
    const onChanged = ({ source, origin }: FilesChanged) => {
      if (origin === instanceId) return;
      preloader.current?.invalidate();
      cache.current.clear();
      for (const id of visiblePaneIds) {
        if (sameSource(source, panesRef.current[id].source))
          void load(id, requested.current[id].path);
      }
    };
    const lifetime = new AbortController();
    void domainEvents.onFiles(onChanged, lifetime.signal);
    return () => lifetime.abort();
  }, [cache, instanceId, load, preloader, visiblePaneIds]);

  // A panel that points at a session which has ended falls back to this computer.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const alive = new Set(sessions.map((item) => item.id));
      const stale = visiblePaneIds.filter((id) => {
        const source = panesRef.current[id].source;
        return source.kind === "remote" && !alive.has(source.sessionId);
      });
      if (stale.length === 0) {
        return;
      }
      const next = { ...panesRef.current };
      for (const id of stale)
        next[id] = { source: LOCAL_SOURCE, state: EMPTY, view: preferencesFor(id, LOCAL_SOURCE) };
      panesRef.current = next;
      setPanes(next);
      for (const id of stale) {
        void load(id, null, null, LOCAL_SOURCE);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [sessions, load, preferencesFor, visiblePaneIds]);

  // Both panels refresh once a transfer they started has settled.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      let settled = false;
      for (const item of useTransfers.getState().items) {
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
      for (const id of visiblePaneIds) {
        preloader.current?.invalidate();
        cache.current.clear();
        void load(id, requested.current[id].path);
        domainEvents.filesChanged({ source: panesRef.current[id].source, origin: instanceId });
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [cache, transferChanges, transferEpoch, load, instanceId, preloader, visiblePaneIds]);

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

  const host = hosts.find((entry) => entry.id === session?.hostId) ?? null;

  const renderedEntries = useMemo(
    () => ({
      a: viewSelectors.a(
        panes.a.state.listing?.entries ?? NO_ENTRIES,
        panes.a.view,
        collator,
        panes.a.state.revealedPaths,
        { query: panes.a.state.filter, kind: panes.a.state.filterKind },
        panes.a.state.collapsedGroups,
      ),
      b: viewSelectors.b(
        panes.b.state.listing?.entries ?? NO_ENTRIES,
        panes.b.view,
        collator,
        panes.b.state.revealedPaths,
        { query: panes.b.state.filter, kind: panes.b.state.filterKind },
        panes.b.state.collapsedGroups,
      ),
    }),
    [panes, collator, viewSelectors],
  );

  const visibleEntries = (id: PaneId): FileEntry[] => {
    const state = panesRef.current[id].state;
    return viewSelectors[id](
      state.listing?.entries ?? NO_ENTRIES,
      panesRef.current[id].view,
      collator,
      state.revealedPaths,
      { query: state.filter, kind: state.filterKind },
      state.collapsedGroups,
    ).entries;
  };

  const updateView = useCallback(
    (id: PaneId, change: Partial<FileViewPreferences>, stateChange: Partial<PaneState> = {}) => {
      const current = panesRef.current[id];
      const view = { ...current.view, ...change };
      const state = { ...current.state, revealedPaths: [], ...stateChange };
      const entries = viewSelectors[id](
        state.listing?.entries ?? NO_ENTRIES,
        view,
        collator,
        state.revealedPaths,
        { query: state.filter, kind: state.filterKind },
        state.collapsedGroups,
      ).entries;
      const visible = new Set(entries.map((entry) => entry.path));
      const next = {
        ...panesRef.current,
        [id]: {
          ...current,
          view,
          state: {
            ...state,
            selectedPaths: state.selectedPaths.filter((path) => visible.has(path)),
            cursor: state.cursor && visible.has(state.cursor) ? state.cursor : null,
            anchor: state.anchor && visible.has(state.anchor) ? state.anchor : null,
          },
        },
      };
      panesRef.current = next;
      setPanes(next);
      if (state.listing && !state.busy) prefetch(id, current.source, state.listing);
      if (Object.keys(change).length) {
        const key = preferenceKey(id, current.source);
        preferenceCache.set(key, view);
        writeFileViewPreferences(key, view);
      }
    },
    [collator, viewSelectors, prefetch, preferenceKey, preferenceCache],
  );

  const focusFilter = (id: PaneId) => {
    patch(id, { filterOpen: true });
    requestAnimationFrame(() => {
      const input = pageRef.current?.querySelector<HTMLInputElement>(
        `[data-pane="${id}"] .sftp-pane__filter input`,
      );
      input?.focus();
      input?.select();
    });
  };

  const selectedEntries = (id: PaneId): FileEntry[] => {
    const state = panesRef.current[id].state;
    const chosen = new Set(state.selectedPaths);
    return visibleEntries(id).filter((entry) => chosen.has(entry.path));
  };

  const primaryEntry = (id: PaneId): FileEntry | null => {
    const state = panesRef.current[id].state;
    const path = state.cursor ?? state.selectedPaths[state.selectedPaths.length - 1];
    return visibleEntries(id).find((entry) => entry.path === path) ?? null;
  };

  const selectEntry = (id: PaneId, entry: FileEntry, mode: "single" | "toggle" | "range") => {
    const state = panesRef.current[id].state;
    const entries = visibleEntries(id);
    let next: string[];
    if (mode === "range" && state.anchor) {
      const start = entries.findIndex((item) => item.path === state.anchor);
      const end = entries.findIndex((item) => item.path === entry.path);
      next =
        start >= 0 && end >= 0
          ? entries.slice(Math.min(start, end), Math.max(start, end) + 1).map((item) => item.path)
          : [entry.path];
    } else if (mode === "toggle") {
      const visibleSelection = selectedEntries(id).map((item) => item.path);
      next = visibleSelection.includes(entry.path)
        ? visibleSelection.filter((path) => path !== entry.path)
        : [...visibleSelection, entry.path];
    } else {
      next = [entry.path];
    }
    patch(id, {
      selectedPaths: next,
      cursor: entry.path,
      anchor: mode === "range" ? state.anchor : entry.path,
    });
    bodies.current[id]?.focus({ preventScroll: true });
    reveal(id);
  };

  const selectAt = (id: PaneId, index: number, extend = false) => {
    const entries = visibleEntries(id);
    const entry = entries[index];
    if (!entry) {
      return;
    }
    selectEntry(id, entry, extend ? "range" : "single");
  };

  const selectByText = (id: PaneId, text: string, at: number) => {
    const { source, state } = panesRef.current[id];
    if (state.busy || state.creating || state.renaming || !state.listing) return;
    const entries = visibleEntries(id);
    const scope = cacheKey(source, state.listing.path);
    const result = typeSelect(
      entries,
      text,
      state.cursor,
      typeSelectState.current[id],
      scope,
      at,
      locale,
    );
    typeSelectState.current[id] = result.state;
    const entry = entries.find((entry) => entry.path === result.path);
    if (entry) selectEntry(id, entry, "single");
  };

  const navigate = (id: PaneId, path: string) => {
    patch(id, {
      creating: null,
      renaming: null,
      revealedPaths: [],
      filter: "",
      filterKind: "all",
      collapsedGroups: [],
    });
    void load(id, path);
  };

  const activateColumn = (id: PaneId, index: number) => {
    const state = panesRef.current[id].state;
    const listing = state.ancestors[index];
    if (!listing || state.busy) return;
    // A column becomes the operation target before selection, menus or shortcuts run.
    requests.current[id]++;
    requested.current[id] = { path: listing.path };
    const history =
      state.history[state.historyIndex] === listing.path
        ? state.history
        : [...state.history.slice(0, state.historyIndex + 1), listing.path];
    patch(id, {
      listing,
      ancestors: state.ancestors.slice(0, index),
      selectedPaths: [],
      cursor: null,
      anchor: null,
      creating: null,
      renaming: null,
      error: null,
      draft: null,
      revealedPaths: [],
      filter: "",
      filterKind: "all",
      collapsedGroups: [],
      history,
      historyIndex: history.length - 1,
    });
    requestAnimationFrame(() => bodies.current[id]?.focus({ preventScroll: true }));
  };

  const travel = (id: PaneId, delta: number) => {
    const state = panesRef.current[id].state;
    const index = state.historyIndex + delta;
    const path = state.history[index];
    if (path) {
      patch(id, {
        creating: null,
        renaming: null,
        revealedPaths: [],
        filter: "",
        filterKind: "all",
        collapsedGroups: [],
      });
      void load(id, path, null, undefined, index);
    }
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
    preloader.current?.invalidate();
    cache.current.clear();
    domainEvents.filesChanged({ source, origin: instanceId });
    await Promise.all(
      visiblePaneIds
        .filter((id) => sameSource(panesRef.current[id].source, source))
        .map((id) => load(id, requested.current[id].path)),
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
      if (
        sameSource(source, panesRef.current[id].source) &&
        panesRef.current[id].state.listing?.path === state.listing?.path &&
        requested.current[id].path === state.listing?.path
      )
        patch(id, {
          renaming: null,
          revealedPaths: [...panesRef.current[id].state.revealedPaths, target],
        });
      await refreshSource(source);
      if (
        !sameSource(source, panesRef.current[id].source) ||
        panesRef.current[id].state.listing?.path !== state.listing?.path ||
        requested.current[id].path !== state.listing?.path
      )
        return;
      patch(id, { selectedPaths: [target], cursor: target, anchor: target });
      reveal(id, target);
      bodies.current[id]?.focus({ preventScroll: true });
    } catch (error) {
      if (
        sameSource(source, panesRef.current[id].source) &&
        panesRef.current[id].state.listing?.path === state.listing?.path &&
        requested.current[id].path === state.listing?.path
      )
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
      if (
        sameSource(source, panesRef.current[id].source) &&
        panesRef.current[id].state.listing?.path === directory &&
        requested.current[id].path === directory
      )
        patch(id, {
          creating: null,
          revealedPaths: [...panesRef.current[id].state.revealedPaths, target],
        });
      await refreshSource(source);
      if (
        !sameSource(source, panesRef.current[id].source) ||
        panesRef.current[id].state.listing?.path !== directory ||
        requested.current[id].path !== directory
      )
        return;
      patch(id, { selectedPaths: [target], cursor: target, anchor: target });
      reveal(id, target);
      bodies.current[id]?.focus({ preventScroll: true });
    } catch (error) {
      if (
        sameSource(source, panesRef.current[id].source) &&
        panesRef.current[id].state.listing?.path === directory &&
        requested.current[id].path === directory
      )
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
    copyText(entry.path);
  };

  const previewEntry = (id: PaneId, entry: FileEntry) => {
    if (!entry.isDir) useFilePreview.getState().show(entry.path, 0, 0, panesRef.current[id].source);
  };

  const toggleHidden = (id: PaneId) =>
    updateView(id, { filesShowHidden: !panesRef.current[id].view.filesShowHidden });

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
      separatorBefore?: boolean;
      onSelect: () => void;
    }> = [];

    if (entry) {
      if (!panesRef.current[id].state.selectedPaths.includes(entry.path)) {
        patch(id, { selectedPaths: [entry.path], anchor: entry.path, cursor: entry.path });
      } else patch(id, { cursor: entry.path });
      if (entry.isDir) {
        items.push({ label: t("sftp.open"), onSelect: () => navigate(id, entry.path) });
      } else {
        items.push({ label: t("sftp.preview"), onSelect: () => previewEntry(id, entry) });
        items.push({
          label: t(source.kind === "local" ? "sftp.openWith" : "sftp.edit"),
          onSelect: () => applyEntry(id, entry),
        });
      }
      items.push({
        label: t("sftp.cut"),
        separatorBefore: true,
        onSelect: () => clipSelection(id, "cut"),
      });
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
      items.push({
        label: t("sftp.rename"),
        separatorBefore: true,
        onSelect: () => startRename(id, entry),
      });
      items.push({ label: t("sftp.copyPath"), onSelect: () => copyPath(entry) });
      items.push({
        label: t("common.delete"),
        separatorBefore: true,
        danger: true,
        onSelect: () => removeSelection(id),
      });
    } else {
      items.push({ label: t("sftp.newFile"), onSelect: () => startCreate(id, "file") });
      items.push({ label: t("sftp.newFolder"), onSelect: () => startCreate(id, "folder") });
      items.push({
        label: t("sftp.paste"),
        separatorBefore: true,
        disabled: !canPaste(clip, source, directory),
        onSelect: () => pasteInto(id, directory),
      });
      items.push({
        label: t("sftp.refresh"),
        separatorBefore: true,
        onSelect: () => void load(id, directory),
      });
    }
    openMenu(event.clientX, event.clientY, items, bodies.current[id]);
  };

  const onKeyDown = (event: React.KeyboardEvent, id: PaneId) => {
    if (
      (isTextTarget(event.target) &&
        !(event.target as HTMLElement).classList.contains("sftp-type-select")) ||
      event.nativeEvent.isComposing ||
      event.nativeEvent.keyCode === 229
    )
      return;
    const state = panesRef.current[id].state;
    const entries = visibleEntries(id);
    const primary = primaryEntry(id);
    const index = primary ? entries.findIndex((item) => item.path === primary.path) : -1;
    const overrides = useSettings.getState().settings.keyboardShortcuts;
    const matches = (id: string) => matchesCommand(event.nativeEvent, id, overrides);
    const action = [
      "hidden",
      "back",
      "forward",
      "parent",
      "refresh",
      "selectAll",
      "copy",
      "cut",
      "paste",
      "newFile",
      "newFolder",
      "open",
      "preview",
      "rename",
      "delete",
    ].find((id) => matches(`files.${id}`));
    if (action) {
      event.preventDefault();
      event.stopPropagation();
      if (action === "hidden") toggleHidden(id);
      else if (action === "back" || action === "forward") travel(id, action === "back" ? -1 : 1);
      else if (action === "refresh") void load(id, requested.current[id].path, state.cursor);
      else if (!state.busy) {
        if (action === "parent" && state.listing) navigate(id, parentOf(state.listing.path));
        else if (action === "selectAll")
          patch(id, {
            selectedPaths: entries.map((item) => item.path),
            anchor: entries[0]?.path ?? null,
            cursor: entries[entries.length - 1]?.path ?? null,
          });
        else if ((action === "copy" || action === "cut") && selectedEntries(id).length > 0)
          clipSelection(id, action);
        else if (action === "paste") pasteInto(id, state.listing?.path ?? "");
        else if (action === "newFile" || action === "newFolder")
          startCreate(id, action === "newFile" ? "file" : "folder");
        else if (action === "preview" && primary) previewEntry(id, primary);
        else if (action === "open" && primary) {
          if (primary.isDir) navigate(id, primary.path);
          else applyEntry(id, primary);
        } else if (action === "rename" && selectedEntries(id).length === 1)
          startRename(id, selectedEntries(id)[0]!);
        else if (action === "delete" && selectedEntries(id).length > 0) removeSelection(id);
      }
      return;
    }
    if (state.busy || event.ctrlKey || event.metaKey || event.altKey) return;
    if (
      panesRef.current[id].view.filesLayout === "columns" &&
      event.key === "ArrowRight" &&
      primary?.isDir
    ) {
      event.preventDefault();
      event.stopPropagation();
      navigate(id, primary.path);
    } else if (
      panesRef.current[id].view.filesLayout === "columns" &&
      event.key === "ArrowLeft" &&
      state.ancestors.length
    ) {
      event.preventDefault();
      event.stopPropagation();
      const parent = state.ancestors[state.ancestors.length - 1]!;
      const folder = parent.entries.find((entry) => entry.path === state.listing?.path);
      activateColumn(id, state.ancestors.length - 1);
      if (folder) selectEntry(id, folder, "single");
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      selectAt(id, Math.min(entries.length - 1, index + 1), event.shiftKey);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      selectAt(id, Math.max(0, index - 1), event.shiftKey);
    } else if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      selectAt(id, event.key === "Home" ? 0 : entries.length - 1, event.shiftKey);
    } else if (event.key === "Escape") {
      delete typeSelectState.current[id];
      patch(id, { creating: null, renaming: null, selectedPaths: [], anchor: null, cursor: null });
    } else if (
      event.key.length === 1 &&
      !(event.target as HTMLElement).classList.contains("sftp-type-select")
    ) {
      event.preventDefault();
      selectByText(id, event.key, event.timeStamp);
    }
  };

  const chooseSource = (id: PaneId, value: string) => {
    const source: FsSource =
      value === "local"
        ? LOCAL_SOURCE
        : { kind: "remote", sessionId: value.slice("remote:".length) };
    const next = {
      ...panesRef.current,
      [id]: { source, state: EMPTY, view: preferencesFor(id, source) },
    };
    panesRef.current = next;
    setPanes(next);
    void load(id, null, null, source);
    setActive(id);
  };

  const refreshPane = (id: PaneId, keep?: string | null) => {
    void load(id, requested.current[id].path, keep);
  };

  if (!session && !single) {
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

  /* eslint-disable react-hooks/refs -- These JSX helpers read refs only in deferred DOM event callbacks. The compiler currently treats nested render helpers as eager calls. */
  const renderPane = (id: PaneId) => {
    const model = panes[id];
    const state = model.state;
    const source = model.source;
    const view = model.view;
    const fileView = renderedEntries[id];
    const entries = fileView.entries;
    const positions = new Map(entries.map((entry, index) => [entry.path, index]));
    const groupLabel = (key: string) => {
      if (view.filesGroupBy === "type")
        return key === "folders"
          ? t("sftp.groupFolders")
          : key === "files"
            ? t("sftp.groupFiles")
            : t("sftp.extensionType", {
                extension: key.slice("extension:".length).toLocaleUpperCase(locale),
              });
      if (view.filesGroupBy === "modified")
        return key === "unknown"
          ? t("sftp.unknownDate")
          : dateFormatter.format(new Date(`${key}T12:00:00`));
      return key;
    };
    const draft = state.draft ?? state.listing?.path ?? "";
    const columnView = view.filesLayout === "columns";
    const renaming = state.renaming;
    const creating = state.creating;
    const selectedSet = new Set(state.selectedPaths);
    const selectedCount = entries.filter((entry) => selectedSet.has(entry.path)).length;
    const previewTarget =
      selectedCount === 1
        ? entries.find((entry) => selectedSet.has(entry.path) && !entry.isDir)
        : undefined;
    const cutSet =
      clip?.action === "cut" && sameSource(clip.source, source)
        ? new Set(clip.items.map((item) => item.path))
        : new Set<string>();
    const primary =
      entries.find(
        (item) =>
          item.path === (state.cursor ?? state.selectedPaths[state.selectedPaths.length - 1]),
      ) ?? null;

    const renderRow = (entry: FileEntry, index: number, ancestorIndex?: number) => {
      const branchPath =
        ancestorIndex === undefined
          ? null
          : (state.ancestors[ancestorIndex + 1] ?? state.listing)?.path;
      return (
        <div
          key={entry.path}
          id={
            ancestorIndex === undefined
              ? `${instanceId}-${id}-row-${positions.get(entry.path)}`
              : `${instanceId}-${id}-ancestor-${ancestorIndex}-${index}`
          }
          data-path={entry.path}
          role="option"
          aria-selected={
            ancestorIndex === undefined ? selectedSet.has(entry.path) : branchPath === entry.path
          }
          className={cn(
            "sftp-row",
            ancestorIndex === undefined && selectedSet.has(entry.path) && "is-selected",
            branchPath === entry.path && "is-branch",
            dropTarget?.pane === id && dropTarget.path === entry.path && "is-drop",
            cutSet.has(entry.path) && "is-cut",
          )}
          draggable={!state.busy && renaming?.path !== entry.path}
          onDragStart={(event) => {
            if (ancestorIndex !== undefined) activateColumn(id, ancestorIndex);
            dragOrigin.current = id;
            const chosen = selectedEntries(id);
            const items = chosen.some((item) => item.path === entry.path) ? chosen : [entry];
            if (!chosen.some((item) => item.path === entry.path)) {
              patch(id, {
                selectedPaths: [entry.path],
                anchor: entry.path,
                cursor: entry.path,
              });
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
            if (ancestorIndex !== undefined) activateColumn(id, ancestorIndex);
            const mode = event.shiftKey
              ? "range"
              : event.ctrlKey || event.metaKey
                ? "toggle"
                : "single";
            selectEntry(id, entry, mode);
            if (columnView && entry.isDir && mode === "single") navigate(id, entry.path);
          }}
          onDoubleClick={() => {
            if (state.busy || renaming?.path === entry.path) return;
            if (columnView && entry.isDir) return;
            if (ancestorIndex !== undefined) activateColumn(id, ancestorIndex);
            if (entry.isDir) {
              navigate(id, entry.path);
            } else {
              applyEntry(id, entry);
            }
          }}
          onContextMenu={(event) => {
            if (ancestorIndex !== undefined) activateColumn(id, ancestorIndex);
            openEntryMenu(event, id, entry);
          }}
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
                patch(id, {
                  renaming: { path: entry.path, value: event.target.value },
                })
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
          <span
            className="sftp-row__type"
            title={
              entry.isDir ? t("sftp.groupFolders") : fileExtension(entry).toLocaleUpperCase(locale)
            }
          >
            {entry.isDir
              ? t("sftp.groupFolders")
              : fileExtension(entry).toLocaleUpperCase(locale) || "—"}
          </span>
          <span className="sftp-row__size">{entry.isDir ? "" : formatBytes(entry.size)}</span>
          <span className="sftp-row__time">
            {entry.modified !== null &&
            Number.isFinite(entry.modified) &&
            !Number.isNaN(new Date(entry.modified).getTime())
              ? dateFormatter.format(entry.modified)
              : ""}
          </span>
          {columnView && entry.isDir ? (
            <ChevronRight className="sftp-row__disclosure" size={12} aria-hidden="true" />
          ) : null}
        </div>
      );
    };

    return (
      <section
        key={id}
        className={cn("sftp-pane", active === id && "is-active")}
        data-pane={id}
        onMouseDown={() => setActive(id)}
        onKeyDownCapture={(event) => {
          const overrides = useSettings.getState().settings.keyboardShortcuts;
          if (matchesCommand(event.nativeEvent, "files.filter", overrides)) {
            event.preventDefault();
            event.stopPropagation();
            setActive(id);
            focusFilter(id);
            return;
          }
          if (matchesCommand(event.nativeEvent, "files.path", overrides)) {
            event.preventDefault();
            event.stopPropagation();
            setActive(id);
            if (!state.pathEditing) patch(id, { pathEditing: true });
            else {
              const path =
                event.currentTarget.querySelector<HTMLInputElement>(".sftp-pane__path input");
              path?.focus();
              path?.select();
            }
          }
        }}
      >
        <header className="sftp-pane__head">
          <Select
            label={t("sftp.source")}
            footerAction={{ label: t("sftp.connectRemote"), onSelect: () => setRemotePane(id) }}
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
                refreshPane(id, state.selectedPaths[state.selectedPaths.length - 1] ?? null)
              }
            >
              <RotateCw size={13} />
            </IconButton>
            <IconButton
              label={t("sftp.preview")}
              size="sm"
              disabled={state.busy || !previewTarget}
              onClick={() => previewTarget && previewEntry(id, previewTarget)}
            >
              <Eye size={13} />
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
            {!single ? (
              <IconButton
                label={t(transferKey(source, panes[other(id)].source))}
                size="sm"
                disabled={
                  state.busy ||
                  panes[other(id)].state.busy ||
                  selectedCount === 0 ||
                  !panes[other(id)].state.listing
                }
                onClick={() => transferSelected(id)}
              >
                <ArrowLeftRight size={13} />
              </IconButton>
            ) : null}
            {!single ? (
              <IconButton
                label={t("sftp.detachPanel")}
                size="sm"
                disabled={!state.listing}
                onClick={() => {
                  const title =
                    source.kind === "local"
                      ? t("sftp.thisComputer")
                      : (sessions.find((item) => item.id === source.sessionId)?.title ??
                        t("sftp.remote"));
                  const tabId = useWorkspace.getState().openFilePane(
                    {
                      source,
                      path: state.listing?.path ?? null,
                      ownerSessionId: sessionId,
                      view,
                    },
                    title,
                  );
                  useWorkspace.getState().splitTab(tabId, "row");
                }}
              >
                <PanelRightOpen size={13} />
              </IconButton>
            ) : null}
            <FileViewMenu
              view={view}
              onChange={(change) =>
                updateView(
                  id,
                  change,
                  change.filesGroupBy !== undefined ? { collapsedGroups: [] } : {},
                )
              }
              onReset={() => {
                const defaults = useSettings.getState().settings;
                updateView(
                  id,
                  {
                    filesShowHidden: defaults.filesShowHidden,
                    filesFoldersFirst: defaults.filesFoldersFirst,
                    filesSortBy: defaults.filesSortBy,
                    filesSortDirection: defaults.filesSortDirection,
                    filesGroupBy: "none",
                    filesLayout: "details",
                  },
                  { filter: "", filterKind: "all", filterOpen: false, collapsedGroups: [] },
                );
              }}
            />
            <IconButton
              label={t("sftp.filterFiles")}
              size="sm"
              active={state.filterOpen}
              onClick={() =>
                state.filterOpen
                  ? updateView(id, {}, { filterOpen: false, filter: "", filterKind: "all" })
                  : focusFilter(id)
              }
            >
              <Search size={13} />
            </IconButton>
          </div>
        </header>

        <FilePathBar
          key={keyForSource(source)}
          source={source}
          path={state.listing?.path ?? ""}
          draft={draft}
          editing={state.pathEditing}
          busy={state.busy}
          view={view}
          history={state.history}
          onDraft={(value) => patch(id, { draft: value })}
          onEditing={(editing) =>
            patch(id, { pathEditing: editing, ...(!editing ? { draft: null } : {}) })
          }
          onNavigate={(path) => navigate(id, path)}
        />

        {state.filterOpen ? (
          <div
            className="sftp-pane__filter"
            onKeyDown={(event) => {
              if (event.key === "Escape" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                event.stopPropagation();
                updateView(id, {}, { filter: "", filterKind: "all", filterOpen: false });
                bodies.current[id]?.focus();
              }
            }}
          >
            <Input
              aria-label={t("sftp.filterFiles")}
              placeholder={t("sftp.filterPlaceholder")}
              spellCheck={false}
              value={state.filter}
              onChange={(event) => updateView(id, {}, { filter: event.target.value })}
            />
            <Select
              label={t("sftp.filterKind")}
              value={state.filterKind}
              options={[
                { value: "all", label: t("sftp.filterAll") },
                { value: "files", label: t("sftp.filterOnlyFiles") },
                { value: "folders", label: t("sftp.filterOnlyFolders") },
              ]}
              onChange={(value) => updateView(id, {}, { filterKind: value as FileKindFilter })}
            />
            <IconButton
              label={t("sftp.closeFilter")}
              size="sm"
              onClick={() => {
                updateView(id, {}, { filter: "", filterKind: "all", filterOpen: false });
                bodies.current[id]?.focus();
              }}
            >
              <X size={12} />
            </IconButton>
          </div>
        ) : null}
        <div className={columnView ? "sftp-miller" : "sftp-details"}>
          {columnView
            ? state.ancestors.map((listing, columnIndex) => (
                <div className="sftp-miller__column" key={listing.path}>
                  <div className="sftp-miller__heading" title={listing.path}>
                    {listing.path}
                  </div>
                  <div
                    className="sftp-pane__body"
                    data-column-path={listing.path}
                    onScroll={(event) =>
                      rememberColumnScroll(id, listing.path, event.currentTarget.scrollTop)
                    }
                    role="listbox"
                    tabIndex={0}
                    aria-label={listing.path}
                    aria-multiselectable="true"
                    onFocus={(event) => {
                      if (event.target === event.currentTarget)
                        event.currentTarget
                          .querySelector<HTMLInputElement>(".sftp-type-select")
                          ?.focus({ preventScroll: true });
                    }}
                    onKeyDown={(event) => {
                      const proxy = (event.target as HTMLElement).classList.contains(
                        "sftp-type-select",
                      );
                      if (
                        (isTextTarget(event.target) && !proxy) ||
                        event.nativeEvent.isComposing ||
                        event.nativeEvent.keyCode === 229
                      )
                        return;
                      if (
                        proxy &&
                        event.key.length === 1 &&
                        !event.ctrlKey &&
                        !event.metaKey &&
                        !event.altKey
                      )
                        return;
                      const branch = (state.ancestors[columnIndex + 1] ?? state.listing)?.path;
                      activateColumn(id, columnIndex);
                      const entry = listing.entries.find((item) => item.path === branch);
                      if (entry) selectEntry(id, entry, "single");
                      onKeyDown(event, id);
                    }}
                    onContextMenu={(event) => {
                      if ((event.target as HTMLElement).closest(".sftp-row")) return;
                      activateColumn(id, columnIndex);
                      openEntryMenu(event, id, null);
                    }}
                    onDragOver={(event) => {
                      if (state.busy || !event.dataTransfer.types.includes(DRAG_MIME)) return;
                      event.preventDefault();
                      event.dataTransfer.dropEffect = dragOrigin.current === id ? "move" : "copy";
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      const payload = readDragPayload(event.dataTransfer);
                      setDropTarget(null);
                      if (payload) handleDrop(id, listing.path, payload);
                    }}
                  >
                    <FileTypeSelect
                      onText={(text, at) => {
                        activateColumn(id, columnIndex);
                        selectByText(id, text, at);
                      }}
                    />
                    {visibleFiles(listing.entries, view, collator).map((entry, index) =>
                      renderRow(entry, index, columnIndex),
                    )}
                  </div>
                </div>
              ))
            : null}
          <div
            className={cn("sftp-pane__scroll", columnView && "sftp-miller__column")}
            key={columnView ? state.listing?.path : "details"}
          >
            {columnView ? (
              <div className="sftp-miller__heading" title={state.listing?.path}>
                {state.listing?.path}
              </div>
            ) : (
              <table className="sftp-columns" aria-label={t("sftp.sortColumns")}>
                <thead>
                  <tr>
                    {(["name", "type", "size", "modified"] as const).map((sort) => (
                      <th
                        key={sort}
                        className={`sftp-columns__${sort}`}
                        scope="col"
                        aria-sort={
                          view.filesSortBy === sort
                            ? view.filesSortDirection === "asc"
                              ? "ascending"
                              : "descending"
                            : "none"
                        }
                      >
                        <button
                          type="button"
                          onClick={() =>
                            updateView(id, {
                              filesSortBy: sort,
                              filesSortDirection:
                                view.filesSortBy === sort && view.filesSortDirection === "asc"
                                  ? "desc"
                                  : "asc",
                            })
                          }
                        >
                          <span>
                            {t(
                              sort === "name"
                                ? "sftp.sortName"
                                : sort === "type"
                                  ? "sftp.sortType"
                                  : sort === "size"
                                    ? "sftp.sortSize"
                                    : "sftp.sortModified",
                            )}
                          </span>
                          {view.filesSortBy === sort ? (
                            <ArrowUp
                              size={11}
                              className={view.filesSortDirection === "desc" ? "is-desc" : undefined}
                              aria-hidden="true"
                            />
                          ) : null}
                        </button>
                      </th>
                    ))}
                  </tr>
                </thead>
              </table>
            )}

            <div
              ref={(element) => {
                bodies.current[id] = element;
              }}
              className={cn(
                "sftp-pane__body",
                dropTarget?.pane === id && dropTarget.path === "" && "is-drop",
              )}
              data-column-path={state.listing?.path}
              onScroll={(event) => {
                if (columnView && state.listing)
                  rememberColumnScroll(id, state.listing.path, event.currentTarget.scrollTop);
              }}
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
              onFocus={(event) => {
                if (event.target === event.currentTarget)
                  event.currentTarget
                    .querySelector<HTMLInputElement>(".sftp-type-select")
                    ?.focus({ preventScroll: true });
              }}
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
              <FileTypeSelect onText={(text, at) => selectByText(id, text, at)} />
              {state.error ? <p className="sftp-pane__error">{state.error}</p> : null}
              {!state.busy && state.listing && fileView.total === 0 && !creating ? (
                <p className="sftp-pane__empty">
                  {t(state.filter || state.filterKind !== "all" ? "sftp.noMatches" : "sftp.empty")}
                </p>
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
                    aria-label={
                      creating.kind === "folder" ? t("sftp.folderName") : t("sftp.fileName")
                    }
                    placeholder={
                      creating.kind === "folder" ? t("sftp.folderName") : t("sftp.fileName")
                    }
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

              {fileView.groups.map((group) => (
                <div key={group.key} role="presentation">
                  {view.filesGroupBy && view.filesGroupBy !== "none" ? (
                    <button
                      type="button"
                      className="sftp-group"
                      aria-expanded={!group.collapsed}
                      onKeyDown={(event) => event.stopPropagation()}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                      }}
                      onClick={() =>
                        updateView(
                          id,
                          {},
                          {
                            collapsedGroups: group.collapsed
                              ? state.collapsedGroups.filter((key) => key !== group.key)
                              : [...state.collapsedGroups, group.key],
                          },
                        )
                      }
                    >
                      <ChevronRight
                        size={12}
                        className={!group.collapsed ? "is-expanded" : undefined}
                      />
                      <span>{groupLabel(group.key)}</span>
                      <span className="sftp-group__count">{group.entries.length}</span>
                    </button>
                  ) : null}
                  {!group.collapsed
                    ? group.entries.map((entry) => renderRow(entry, positions.get(entry.path)!))
                    : null}
                </div>
              ))}
            </div>
          </div>
        </div>

        <footer className="sftp-pane__foot">
          <span className="sftp-pane__status" role="status" aria-live="polite" aria-atomic="true">
            {state.busy
              ? t("sftp.loading")
              : state.listing
                ? t("sftp.itemCount", { count: fileView.total })
                : "—"}
          </span>
          {selectedCount > 1 ? (
            <span className="sftp-pane__selection">
              {t("sftp.selectedCount", { count: selectedCount })}
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
      {remotePane ? (
        <FileRemoteDialog
          onClose={() => setRemotePane(null)}
          onConnected={(connected) => {
            chooseSource(remotePane, `remote:${connected.id}`);
            setRemotePane(null);
          }}
        />
      ) : null}
      {single ? (
        <div className="sftp-panes sftp-panes--single">{renderPane("a")}</div>
      ) : (
        <FileSplitView
          key={scopeId ?? sessionId}
          storageKey={`tunnelde:file-split:${scopeId ?? session?.hostId ?? sessionId}`}
          left={renderPane("a")}
          right={renderPane("b")}
        />
      )}

      <FileTransfers />
    </div>
  );
  /* eslint-enable react-hooks/refs */
}
