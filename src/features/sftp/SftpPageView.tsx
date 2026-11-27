import type { FilePageServices } from "./filePageServices";
import type { SftpPageProps } from "./SftpPage";
import { isTextTarget } from "@/lib/keyboard/registry";
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
  GripVertical,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { EmptyState, StatusDot } from "@/components/ui/display/Misc";
import { FileTypeIcon } from "@/components/ui/display/FileTypeIcon";
import { useColumnReorder } from "@/components/ui/display/useColumnReorder";
import { Button, IconButton } from "@/components/ui/form/Button";
import { Input } from "@/components/ui/form/Field";
import { Select } from "@/components/ui/form/Select";
import { FileViewMenu } from "./FileViewMenu";
import { FilePathBar } from "./FilePathBar";
import { FileTypeSelect } from "./FileTypeSelect";
import { FileSplitView } from "./FileSplitView";
import { fitFileColumn } from "@/lib/files/columnWidth";
import { typeSelect, type TypeSelectState } from "@/lib/files/typeSelect";
import { columnAncestors, pathForEditing, pathForNavigation } from "@/lib/files/navigation";
import { type FilesChanged } from "@/lib/events/domain";
import { presentError } from "@/lib/api/errors";
import type { FileEntry, FsSource, Listing } from "@/lib/api/types";
import { isIpcError } from "@/lib/api/types";
import {
  canPaste,
  clearDragSource,
  currentDragSource,
  hasDragPayload,
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
import { LOCAL_SOURCE, sourceKey } from "@/lib/files/fs";
import { createPrefetchQueue } from "@/lib/files/prefetch";
import {
  FILE_COLUMNS,
  DEFAULT_COLUMN_WIDTHS,
  type FileColumn,
  createGroupedFileViewSelector,
  fileExtension,
  visibleFiles,
  type FileViewPreferences,
  type FileKindFilter,
} from "@/lib/files/view";
import { fileViewPreferenceKey } from "@/lib/files/preferences";
import { cn, formatBytes } from "@/lib/text/format";
import { useContextMenu } from "@/store/contextMenu";
import { toast } from "@/store/toasts";
import { runBackgroundTask } from "@/lib/tasks/background";
import { type FilePaneOptions } from "@/store/workspace";
import { SearchField } from "@/components/ui/form/SearchField";
import {
  fileHighlightSource,
  matchingFileHighlightLabels,
  resolveFileHighlight,
} from "@/lib/plugins/fileHighlights";
import { useBackgroundGuard } from "@/lib/session/viewState";
import { beginFilePaneDrag, clearFilePaneDrag, FILE_PANE_MIME } from "@/lib/session/filePaneDrag";
import { usePointerDrag } from "@/lib/session/usePointerDrag";

type PaneId = "a" | "b";

const PANE_IDS: PaneId[] = ["a", "b"];
const SINGLE_PANE_IDS: PaneId[] = ["a"];

function columnLayout(view: FileViewPreferences) {
  const columns = view.filesColumns ?? [...FILE_COLUMNS];
  const widths = columns.map((column) =>
    Math.max(56, Math.min(1000, view.filesColumnWidths?.[column] ?? DEFAULT_COLUMN_WIDTHS[column])),
  );
  return {
    columns,
    grid: columns
      .map((column, index) =>
        column === "name" ? `18px ${(widths[index] ?? 56) - 24}px` : `${widths[index]}px`,
      )
      .join(" "),
    minimum: `${widths.reduce((a, b) => a + b, 0) + columns.length * 6 + 16}px`,
  };
}

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

/** Shared renderer: resources and cross-page effects are injected by its owner. */
export function SftpPageView({
  sessionId,
  single,
  scopeId,
  tabId,
  services,
}: SftpPageProps & { services: FilePageServices }) {
  const { t, i18n } = useTranslation();
  const isSingle = !!single;
  const visiblePaneIds = single ? SINGLE_PANE_IDS : PANE_IDS;
  const { sessions, hosts, clip, settings, highlights, resolveFileIcon } = services.useModel();
  const session = sessions.find((item) => item.id === sessionId) ?? null;
  const {
    fs,
    confirm,
    openConnect,
    openEditor,
    setClip,
    copyText,
    watchCutCompletion,
    fileMenuCommands,
    runFileMenuCommand,
    discoverMountedFileActions,
    revealMountedFile,
    FileBrowserSurface,
    FileRemoteDialog,
  } = services;
  const openMenu = useContextMenu((state) => state.open);
  const sameFilesystem = useCallback(
    (left: FsSource, right: FsSource) => services.sameFilesystem(left, right),
    [services],
  );
  const [preferenceCache] = useState(() => new Map<string, FileViewPreferences>());
  const preferenceKey = useCallback(
    (id: PaneId, source: FsSource) => {
      const currentSessions = services.getState().sessions;
      const ownerFor = (remoteId: string) => {
        const hostId = currentSessions.find((item) => item.id === remoteId)?.hostId;
        return hostId ? `host:${hostId}` : `session:${remoteId}`;
      };
      const windowLabel = services.windowLabel();
      return fileViewPreferenceKey(
        windowLabel,
        scopeId ?? ownerFor(sessionId),
        id,
        source.kind === "local" ? "local" : ownerFor(source.sessionId),
      );
    },
    [sessionId, scopeId, services],
  );
  const preferencesFor = useCallback(
    (id: PaneId, source: FsSource) => {
      const key = preferenceKey(id, source);
      let value = preferenceCache.get(key);
      if (!value) {
        const defaults = services.getState().settings;
        value = services.readPreferences(key, {
          filesShowHidden: defaults.filesShowHidden,
          filesFoldersFirst: defaults.filesFoldersFirst,
          filesSortBy: defaults.filesSortBy,
          filesSortDirection: defaults.filesSortDirection,
        });
        preferenceCache.set(key, value);
      }
      return value;
    },
    [preferenceKey, preferenceCache, services],
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

  const checkpointKey = `files:${scopeId ?? sessionId}`;
  const initialSinglePath = useRef(single?.path);
  const [panes, setPanes] = services.useViewState<Record<PaneId, PaneModel>>(checkpointKey, () => ({
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
  const [initialized, setInitialized] = useState(false);
  const [active, setActive] = services.useViewState<PaneId>(`${checkpointKey}:active`, "a");
  useLayoutEffect(() => {
    services.rendered?.(
      initialized &&
        visiblePaneIds.every(
          (id) => !panes[id].state.busy && !!(panes[id].state.listing || panes[id].state.error),
        ),
    );
  }, [services, panes, visiblePaneIds, initialized]);
  const sourceA = panes.a.source;
  const sourceB = panes.b.source;
  useEffect(() => {
    if (!tabId) return;
    const candidates = single
      ? [sourceA]
      : active === "a"
        ? [sourceA, sourceB]
        : [sourceB, sourceA];
    const remote = candidates.find((source) => source.kind === "remote");
    services.workspace.setFileSession(
      tabId,
      remote?.kind === "remote" ? remote.sessionId : null,
      (single ? [sourceA] : [sourceA, sourceB]).flatMap((source) =>
        source.kind === "remote" ? [source.sessionId] : [],
      ),
    );
  }, [tabId, single, active, sourceA, sourceB, services.workspace]);
  useBackgroundGuard(panes.a.state.busy || panes.b.state.busy);
  const [remotePane, setRemotePane] = useState<PaneId | null>(null);
  const [dropTarget, setDropTarget] = useState<{ pane: PaneId; path: string } | null>(null);
  const instanceId = useId();
  useEffect(() => {
    services.searchRoots.publish(
      instanceId,
      [active, other(active)].flatMap((id) => {
        const pane = panes[id];
        return pane.state.listing
          ? [
              {
                id: `${instanceId}:${id}`,
                tabId: tabId ?? `sftp:${sessionId}`,
                path: pane.state.listing.path,
                sessionId: pane.source.kind === "remote" ? pane.source.sessionId : null,
              },
            ]
          : [];
      }),
    );
  }, [instanceId, active, panes, sessionId, tabId, services.searchRoots]);
  useEffect(
    () => () => services.searchRoots.remove(instanceId),
    [instanceId, services.searchRoots],
  );
  const pageRef = useRef<HTMLDivElement>(null);
  const nativeDrop = useRef<(paths: string[], x: number, y: number) => void>(() => undefined);
  const panesRef = useRef(panes);
  const bodies = useRef<Record<PaneId, HTMLDivElement | null>>({ a: null, b: null });
  const columnScroll = useRef(new Map<string, number>());
  const requests = useRef({ a: 0, b: 0 });
  // A refresh must follow an in-flight navigation, whose listing can still show the old path.
  const requested = useRef<Record<PaneId, { path: string | null; historyIndex?: number }>>({
    a: { path: null },
    b: { path: null },
  });
  const mounted = useRef(true);
  const mutations = useRef(new Set<PaneId>());
  const typeSelectState = useRef<Partial<Record<PaneId, TypeSelectState>>>({});
  const beginColumnResize = usePointerDrag();
  const columnReorder = useColumnReorder();

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

  const patch = useCallback(
    (id: PaneId, next: Partial<PaneState>) => {
      if (!mounted.current) return;
      const current = panesRef.current;
      const updated = {
        ...current,
        [id]: { ...current[id], state: { ...current[id].state, ...next } },
      };
      panesRef.current = updated;
      setPanes(updated);
    },
    [setPanes],
  );

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
      enabled: () => {
        const settings = services.getState().settings;
        return settings.preloadDirs && !settings.lightweightMode;
      },
      cached: (key) => cache.current.has(key),
    });
    preloader.current = queue;
    return () => {
      queue.invalidate();
      preloader.current = null;
    };
  }, [services]);

  // Warm the parent and the first few child folders so moving around feels instant.
  const prefetch = useCallback(
    (id: PaneId, source: FsSource, listing: Listing) => {
      if (
        !services.getState().settings.preloadDirs ||
        services.getState().settings.lightweightMode
      ) {
        return;
      }
      const preferences = services.getState().settings;
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
    [preloader, remember, viewSelectors, fs, services],
  );

  useEffect(() => {
    if (!settings.preloadDirs || settings.lightweightMode) {
      preloader.current?.invalidate();
      return;
    }
    for (const id of visiblePaneIds) {
      const pane = panesRef.current[id];
      if (pane.state.listing && !pane.state.busy) prefetch(id, pane.source, pane.state.listing);
    }
  }, [
    settings.preloadDirs,
    settings.preloadCount,
    settings.lightweightMode,
    collator,
    prefetch,
    preloader,
    visiblePaneIds,
  ]);

  const load = useCallback(
    async (
      id: PaneId,
      path?: string | null,
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
          ...(previousPath !== cached.path ? { draft: null } : {}),
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
        // Reconcile against current state, including changes made during an asynchronous refresh.
        // A navigation starts a new selection; a refresh must not collapse a multi-selection.
        const sameDirectory = previousPath === listing.path;
        const available = new Set(listing.entries.map((entry) => entry.path));
        const selectedPaths = sameDirectory
          ? current.selectedPaths.filter((path) => available.has(path))
          : [];
        const cursor =
          sameDirectory && current.cursor && available.has(current.cursor)
            ? current.cursor
            : (selectedPaths.at(-1) ?? null);
        const anchor =
          sameDirectory && current.anchor && available.has(current.anchor)
            ? current.anchor
            : (selectedPaths[0] ?? null);
        patch(id, {
          listing,
          ancestors,
          selectedPaths,
          anchor,
          cursor,
          history,
          historyIndex: targetHistoryIndex ?? history.length - 1,
          busy: false,
          draft: sameDirectory ? current.draft : null,
          renaming:
            sameDirectory && current.renaming && available.has(current.renaming.path)
              ? current.renaming
              : null,
          revealedPaths: previousPath === listing.path ? current.revealedPaths : [],
          ...(previousPath !== listing.path
            ? { filter: "", filterKind: "all" as const, collapsedGroups: [] }
            : {}),
        });
        prefetch(id, source, listing);
        return listing;
      } catch (error) {
        if (!mounted.current || requests.current[id] !== version) return null;
        requested.current[id] = { path: panesRef.current[id].state.listing?.path ?? null };
        patch(id, { busy: false, error: presentError(error) });
        return null;
      } finally {
        release?.();
      }
    },
    [cache, patch, prefetch, preloader, remember, fs],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setInitialized(true);
      const first = panesRef.current.a.state;
      void load("a", first.listing?.path ?? initialSinglePath.current);
      if (!isSingle) {
        const second = panesRef.current.b.state;
        void load("b", second.listing?.path);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load, isSingle]);

  useEffect(() => {
    if (!single || !tabId || !panes.a.state.listing) return;
    const saved = services.getState().tabs.find((tab) => tab.id === tabId)?.filePane;
    const path = panes.a.state.listing.path;
    const source = panes.a.source;
    const remote =
      source.kind === "remote" ? sessions.find((item) => item.id === source.sessionId) : null;
    // A disappearing session must not erase the identity needed to reconnect.
    if (source.kind === "remote" && !remote) return;
    if (
      !saved ||
      (saved.source.kind === source.kind &&
        (source.kind === "local" ||
          (saved.source.kind === "remote" && saved.source.sessionId === source.sessionId)) &&
        saved.path === path &&
        (source.kind === "local" ||
          (saved.remoteIdentity?.hostId === remote?.hostId &&
            saved.remoteIdentity?.address === remote?.address)))
    )
      return;
    services.workspace.retainFilePane(
      tabId,
      {
        ...saved,
        source,
        path,
        ownerSessionId: sessionId,
        remoteIdentity: remote ? { hostId: remote.hostId, address: remote.address } : undefined,
      },
      remote?.title ?? t("sftp.thisComputer"),
    );
  }, [single, tabId, panes.a.source, panes.a.state.listing, sessionId, sessions, t, services]);

  useEffect(() => {
    const affected = new Set<PaneId>();
    let timer: number | undefined;
    const onChanged = ({ source, origin }: FilesChanged) => {
      if (origin === instanceId) return;
      for (const id of visiblePaneIds) {
        if (sameFilesystem(source, panesRef.current[id].source)) affected.add(id);
      }
      if (!affected.size || timer !== undefined) return;
      // Coalesce a batch's completion events into one read per visible pane.
      timer = window.setTimeout(() => {
        timer = undefined;
        preloader.current?.invalidate();
        cache.current.clear();
        for (const id of affected) void load(id, requested.current[id].path);
        affected.clear();
      }, 50);
    };
    const lifetime = new AbortController();
    void services.events.onFiles(onChanged, lifetime.signal);
    return () => {
      lifetime.abort();
      window.clearTimeout(timer);
    };
  }, [cache, instanceId, load, preloader, visiblePaneIds, sameFilesystem, services.events]);

  // Keep a detached remote panel available for reconnecting after its session ends.
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
      if (single && tabId && stale.includes("a")) {
        const saved = services.getState().tabs.find((tab) => tab.id === tabId);
        if (saved?.filePane?.remoteIdentity) {
          services.workspace.retainFilePane(
            tabId,
            { ...saved.filePane, offline: true },
            saved.title,
          );
          return;
        }
      }
      const next = { ...panesRef.current };
      for (const id of stale)
        next[id] = { source: LOCAL_SOURCE, state: EMPTY, view: preferencesFor(id, LOCAL_SOURCE) };
      panesRef.current = next;
      setPanes(next);
      if (single && tabId && stale.includes("a")) {
        services.workspace.renameTab(tabId, t("sftp.thisComputer"));
      }
      for (const id of stale) {
        void load(id, null, LOCAL_SOURCE);
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [sessions, load, preferencesFor, visiblePaneIds, setPanes, single, tabId, t, services]);

  // Keep sessions with different connection identities separate if a saved host was edited.
  const canonicalSessions = useMemo(() => {
    const seen = new Set<string>();
    return sessions.filter((item) => {
      if (item.purpose === "forwarding") return false;
      const identity = JSON.stringify([item.hostId, item.address]);
      if (seen.has(identity)) {
        return false;
      }
      seen.add(identity);
      return true;
    });
  }, [sessions]);

  const sourceOptions = useMemo(
    () => [
      { value: "local", label: t("sftp.thisComputer") },
      ...canonicalSessions.map((item) => ({
        value: `remote:${item.id}`,
        label: canonicalSessions.some((other) => other.id !== item.id && other.title === item.title)
          ? `${item.title} (${item.address})`
          : item.title,
      })),
    ],
    [canonicalSessions, t],
  );

  const keyForSource = (source: FsSource): string => {
    if (source.kind === "local") {
      return "local";
    }
    const owner = sessions.find((item) => item.id === source.sessionId);
    const canonical = canonicalSessions.find(
      (item) => item.hostId === owner?.hostId && item.address === owner.address,
    );
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
        services.writePreferences(key, view);
      }
    },
    [collator, viewSelectors, prefetch, preferenceKey, preferenceCache, setPanes, services],
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

  const previewBrowser = (id: PaneId) => ({
    id: `${tabId ?? "files"}:${id}`,
    paths: visibleEntries(id)
      .filter((entry) => !entry.isDir)
      .map((entry) => entry.path),
  });

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
    if (!entry.isDir && mode === "single")
      services.preview(entry.path, panesRef.current[id].source, previewBrowser(id), true);
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
    const destination = pathForNavigation(path, panesRef.current[id].source);
    patch(id, {
      creating: null,
      renaming: null,
      revealedPaths: [],
      filter: "",
      filterKind: "all",
      collapsedGroups: [],
    });
    void load(id, destination);
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
      void load(id, path, undefined, index);
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
    isRelevant?: () => boolean,
  ) => {
    try {
      const transferId = await fs.transfer(from, fromPath, to, toPath, move, overwrite);
      if (onDone && isRelevant) watchCutCompletion(transferId, onDone, isRelevant);
    } catch (error) {
      toast(presentError(error), "error");
    }
  };

  const refreshSource = async (source: FsSource) => {
    preloader.current?.invalidate();
    cache.current.clear();
    services.events.filesChanged({ source, origin: instanceId });
    await Promise.all(
      visiblePaneIds
        .filter((id) => sameFilesystem(panesRef.current[id].source, source))
        .map((id) => load(id, requested.current[id].path)),
    );
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
      toast(presentError(error), "error");
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
    taskTitle = t("sftp.moveItems", { count: ops.length }),
  ) => {
    const execute = async (report?: (completed: number) => void) => {
      for (const [index, op] of ops.entries()) {
        await run(source, op.from, op.to, overwrite);
        onDone?.(op.from);
        report?.(index + 1);
      }
    };
    try {
      if (source.kind === "remote") {
        await runBackgroundTask({ title: taskTitle, cancellable: false }, async ({ report }) => {
          report({ progress: { completed: 0, total: ops.length, unit: "items" } });
          await execute((completed) =>
            report({ progress: { completed, total: ops.length, unit: "items" } }),
          );
        });
      } else {
        await execute();
      }
    } catch (error) {
      toast(
        presentError(error),
        "error",
        isIpcError(error) && error.details?.operation === "rename"
          ? {
              label: t("output.openFile"),
              onClick: () =>
                services.openLatestLog().catch((cause) => toast(presentError(cause), "error")),
            }
          : undefined,
      );
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
      sameFilesystem,
    );
    if (action.kind === "noop") return;
    void approveTargets(target.source, directory, action.ops, (overwrite) => {
      if (action.kind === "copy" || action.kind === "move") {
        void runBatch(
          other(id),
          directory,
          fs.copy,
          action.source,
          action.ops,
          overwrite,
          undefined,
          t("sftp.copyItems", { count: action.ops.length }),
        );
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
    const action = planPaste(clip, target, directory, sameFilesystem);
    if (action.kind === "noop") {
      return;
    }
    const snapshot = clip;
    void approveTargets(target, directory, action.ops, (overwrite) => {
      let remaining: PasteClip | null = snapshot;
      const done =
        snapshot.action === "cut"
          ? (path: string) => {
              const current = services.getState().clip;
              if (!current || current !== remaining) return;
              const items = current.items.filter((item) => item.path !== path);
              remaining = items.length ? { ...current, items } : null;
              services.setClip(remaining);
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
          t(action.kind === "move" ? "sftp.moveItems" : "sftp.copyItems", {
            count: action.ops.length,
          }),
        );
      } else
        for (const op of action.ops)
          void startTransfer(
            action.from,
            op.from,
            action.to,
            op.to,
            action.move,
            done ? () => done(op.from) : undefined,
            overwrite,
            done ? () => remaining !== null && services.getState().clip === remaining : undefined,
          );
    });
  };

  const handleDrop = (id: PaneId, directory: string, payload: DragPayload) => {
    const model = panesRef.current[id];
    if (model.state.busy || !model.state.listing) return;
    const target = model.source;
    const action = resolveDrop(payload, target, directory, `${instanceId}:${id}`, sameFilesystem);
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
          undefined,
          t(action.kind === "move" ? "sftp.moveItems" : "sftp.copyItems", {
            count: action.ops.length,
          }),
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
      const columnPath = element?.closest<HTMLElement>("[data-column-path]")?.dataset.columnPath;
      const listing =
        model.state.ancestors.find((item) => item.path === columnPath) ?? model.state.listing;
      const rowPath = element?.closest<HTMLElement>("[data-path]")?.dataset.path;
      const row = listing.entries.find((entry) => entry.path === rowPath);
      const directory = row?.isDir ? row.path : listing.path;
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
        .catch((error: unknown) => toast(presentError(error), "error"));
    };
  });

  useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | undefined;
    void services
      .onNativeDrop((paths, x, y) => nativeDrop.current(paths, x, y))
      .then((unlisten) => {
        if (disposed) unlisten();
        else cleanup = unlisten;
      })
      .catch((error: unknown) => toast(presentError(error), "error"));
    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [services]);

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
      bodies.current[id]?.focus({ preventScroll: true });
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
        patch(id, { error: presentError(error), busy: false });
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
      bodies.current[id]?.focus({ preventScroll: true });
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
        patch(id, { error: presentError(error), busy: false });
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
          toast(presentError(error), "error");
        } finally {
          await refreshSource(source);
        }
      },
    });
  };

  const applyEntry = (id: PaneId, entry: FileEntry) => {
    const source = panesRef.current[id].source;
    const kind = services.previewKind(entry.path);
    if (kind !== "text") {
      previewEntry(id, entry);
      return;
    }
    if (source.kind === "local") {
      services.workspace.openLocalEditor(entry.path);
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
    if (!entry.isDir) services.preview(entry.path, panesRef.current[id].source, previewBrowser(id));
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
        items.push({ label: t("sftp.open"), onSelect: () => applyEntry(id, entry) });
        if (source.kind === "local")
          items.push({
            label: t("sftp.openWith"),
            onSelect: () =>
              void fs
                .openLocal(entry.path)
                .catch((error: unknown) => toast(presentError(error), "error")),
          });
      }
      if (source.kind === "local") {
        items.push({
          label: t("sftp.revealNative"),
          onSelect: () =>
            void services
              .revealLocalPath(entry.path)
              .catch((error: unknown) => toast(presentError(error), "error")),
        });
        if (entry.isDir)
          items.push({
            label: t("sftp.openFolderNative"),
            onSelect: () =>
              void fs
                .openLocal(entry.path)
                .catch((error: unknown) => toast(presentError(error), "error")),
          });
      }
      for (const contribution of fileMenuCommands(source, entry)) {
        items.push({
          label: `${contribution.pluginName}: ${contribution.title}`,
          separatorBefore: contribution.first,
          onSelect: () => void runFileMenuCommand(contribution, source, entry),
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
        disabled: !canPaste(clip, source, entry.isDir ? entry.path : directory, sameFilesystem),
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
      if (source.kind === "local" && directory)
        items.push({
          label: t("sftp.openFolderNative"),
          onSelect: () =>
            void fs
              .openLocal(directory)
              .catch((error: unknown) => toast(presentError(error), "error")),
        });
      items.push({ label: t("sftp.newFile"), onSelect: () => startCreate(id, "file") });
      items.push({ label: t("sftp.newFolder"), onSelect: () => startCreate(id, "folder") });
      items.push({
        label: t("sftp.paste"),
        separatorBefore: true,
        disabled: !canPaste(clip, source, directory, sameFilesystem),
        onSelect: () => pasteInto(id, directory),
      });
      items.push({
        label: t("sftp.refresh"),
        separatorBefore: true,
        onSelect: () => void load(id, directory),
      });
    }
    openMenu(event.clientX, event.clientY, items, bodies.current[id]);
    if (entry && source.kind === "remote") {
      let opened = useContextMenu.getState().menu;
      let added = false;
      void discoverMountedFileActions(source.sessionId, entry.path, (action) => {
        if (!opened || useContextMenu.getState().menu !== opened) return;
        const item = {
          label: `${t("sftp.revealNative")} · ${action.pluginName}`,
          separatorBefore: !added,
          onSelect: () => void revealMountedFile(action, source.sessionId, entry.path),
        };
        opened = { ...opened, items: [...opened.items, item] };
        added = true;
        useContextMenu.setState({ menu: opened });
      });
    }
  };

  useEffect(() => {
    if (!pageRef.current) return;
    return services.bindShortcuts(pageRef.current, (event) => {
      if (!(event.target instanceof Element)) return [];
      const pane = event.target.closest<HTMLElement>(".sftp-pane");
      const id = pane?.dataset.pane as PaneId | undefined;
      if (!id || !pageRef.current?.contains(pane)) return [];
      const state = panesRef.current[id].state;
      const columnPath = event.target.closest<HTMLElement>(".sftp-pane__body")?.dataset.columnPath;
      const ancestorIndex = state.ancestors.findIndex((listing) => listing.path === columnPath);
      const ancestor = state.ancestors[ancestorIndex];
      const branch =
        ancestorIndex >= 0
          ? (state.ancestors[ancestorIndex + 1] ?? state.listing)?.path
          : undefined;
      const primary = ancestor
        ? (ancestor.entries.find((entry) => entry.path === branch) ?? null)
        : primaryEntry(id);
      const selected = ancestor ? (primary ? [primary] : []) : selectedEntries(id);
      const control = !!event.target.closest("button, a, [role=separator], [role=combobox]");
      const text =
        isTextTarget(event.target) && !event.target.classList.contains("sftp-type-select");
      // Modified file commands remain available after toolbar clicks. Bare keys
      // belong to the focused control (Enter/Space activate, arrows navigate).
      if (
        control &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !/^F\d{1,2}$/.test(event.key)
      )
        return [];
      const actions = [
        "filter",
        "path",
        ...(!text
          ? [
              "hidden",
              "back",
              "forward",
              "refresh",
              ...(!state.busy && state.listing
                ? [
                    "parent",
                    "selectAll",
                    "paste",
                    "newFile",
                    "newFolder",
                    ...(selected.length ? ["copy", "cut", "delete"] : []),
                    ...(selected.length === 1 ? ["rename"] : []),
                    ...(primary ? ["open", "preview"] : []),
                  ]
                : []),
            ]
          : []),
      ];
      return services.shortcutCandidates(
        event,
        actions.map((action) => `files.${action}`),
        (command) => {
          const action = command.slice(6);
          setActive(id);
          if (ancestor && action !== "filter" && action !== "path") {
            activateColumn(id, ancestorIndex);
            if (primary) selectEntry(id, primary, "single");
          }
          if (action === "filter") {
            setActive(id);
            focusFilter(id);
          } else if (action === "path") {
            setActive(id);
            if (!state.pathEditing) patch(id, { pathEditing: true });
            else {
              const input = pane?.querySelector<HTMLInputElement>(".sftp-pane__path input");
              input?.focus();
              input?.select();
            }
          } else if (action === "hidden") toggleHidden(id);
          else if (action === "back" || action === "forward")
            travel(id, action === "back" ? -1 : 1);
          else if (action === "refresh") void load(id, requested.current[id].path);
          else if (action === "parent" && state.listing)
            navigate(id, parentOf(ancestor?.path ?? state.listing.path));
          else if (action === "selectAll") {
            const entries = visibleEntries(id);
            patch(id, {
              selectedPaths: entries.map((item) => item.path),
              anchor: entries[0]?.path ?? null,
              cursor: entries[entries.length - 1]?.path ?? null,
            });
          } else if (action === "copy" || action === "cut") clipSelection(id, action);
          else if (action === "paste") pasteInto(id, ancestor?.path ?? state.listing?.path ?? "");
          else if (action === "newFile" || action === "newFolder")
            startCreate(id, action === "newFile" ? "file" : "folder");
          else if (action === "preview" && primary) previewEntry(id, primary);
          else if (action === "open" && primary) {
            if (primary.isDir) navigate(id, primary.path);
            else applyEntry(id, primary);
          } else if (action === "rename") startRename(id, selected[0]!);
          else if (action === "delete") removeSelection(id);
          else return false;
          return true;
        },
      );
    });
  });

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
    void load(id, null, source);
    if (tabId && (single || source.kind === "remote")) {
      const title =
        source.kind === "local"
          ? t("sftp.thisComputer")
          : (services.getState().sessions.find((item) => item.id === source.sessionId)?.title ??
            t("sftp.remote"));
      if (single) {
        const remote =
          source.kind === "remote"
            ? services.getState().sessions.find((item) => item.id === source.sessionId)
            : undefined;
        services.workspace.retainFilePane(
          tabId,
          {
            source,
            path: null,
            ownerSessionId: sessionId,
            remoteIdentity: remote ? { hostId: remote.hostId, address: remote.address } : undefined,
          },
          title,
        );
      } else {
        services.workspace.renameTab(tabId, title);
      }
    }
    setActive(id);
  };

  const refreshPane = (id: PaneId) => {
    void load(id, requested.current[id].path);
  };

  const filePaneOptions = (id: PaneId): { pane: FilePaneOptions; title: string } => {
    const model = panesRef.current[id];
    const source = model.source;
    return {
      pane: {
        source,
        path: model.state.listing?.path ?? requested.current[id].path,
        ownerSessionId: sessionId,
        view: model.view,
        ...(source.kind === "remote"
          ? (() => {
              const remote = services
                .getState()
                .sessions.find((item) => item.id === source.sessionId);
              return remote
                ? { remoteIdentity: { hostId: remote.hostId, address: remote.address } }
                : {};
            })()
          : {}),
      },
      title:
        source.kind === "local"
          ? t("sftp.thisComputer")
          : (services.getState().sessions.find((item) => item.id === source.sessionId)?.title ??
            t("sftp.remote")),
    };
  };

  const retainOtherPane = (id: PaneId) => {
    if (!tabId) return;
    const remaining = filePaneOptions(other(id));
    services.workspace.retainFilePane(tabId, remaining.pane, remaining.title);
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
    const draft = state.draft ?? pathForEditing(state.listing?.path ?? "", source);
    const columnView = view.filesLayout === "columns";
    const { columns, grid, minimum } = columnLayout(view);
    const columnIndex = (column: FileColumn) => {
      const index = columns.indexOf(column);
      if (index < 0) return 0;
      return 1 + index + (columns.indexOf("name") < index ? 1 : 0);
    };
    const resizeColumn = (column: FileColumn, event: React.PointerEvent<HTMLElement>) => {
      const origin = event.clientX;
      const start = view.filesColumnWidths?.[column] ?? DEFAULT_COLUMN_WIDTHS[column];
      const pane = event.currentTarget.closest<HTMLElement>(".sftp-pane");
      const handle = event.currentTarget;
      let width = start;
      const preview = (next: FileViewPreferences) => {
        const layout = columnLayout(next);
        pane?.style.setProperty("--sftp-columns", layout.grid);
        pane?.style.setProperty("--sftp-min-width", layout.minimum);
        handle.setAttribute(
          "aria-valuenow",
          String(next.filesColumnWidths?.[column] ?? DEFAULT_COLUMN_WIDTHS[column]),
        );
      };
      const move = (next: PointerEvent) => {
        const current = panesRef.current[id];
        if (!Number.isFinite(next.clientX) || !sameSource(current.source, source)) return;
        width = Math.max(56, Math.min(1000, Math.round(start + next.clientX - origin)));
        preview({
          ...current.view,
          filesColumnWidths: { ...current.view.filesColumnWidths, [column]: width },
        });
      };
      beginColumnResize(event, {
        move,
        commit: () => {
          if (!sameSource(panesRef.current[id].source, source)) {
            preview(panesRef.current[id].view);
            return;
          }
          updateView(id, {
            filesColumnWidths: { ...panesRef.current[id].view.filesColumnWidths, [column]: width },
          });
        },
        cancel: () => preview(panesRef.current[id].view),
      });
    };
    const renaming = state.renaming;
    const creating = state.creating;
    const selectedSet = new Set(state.selectedPaths);
    const highlightSource = fileHighlightSource(source);
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
      const highlight = resolveFileHighlight(
        highlights,
        highlightSource,
        entry.path,
        entry.name,
        entry.isDir,
        ancestorIndex === undefined
          ? (state.listing?.path ?? null)
          : (state.ancestors[ancestorIndex]?.path ?? null),
      );
      const highlightLabel = matchingFileHighlightLabels(
        highlights,
        highlightSource,
        entry.path,
        entry.name,
        entry.isDir,
        ancestorIndex === undefined
          ? (state.listing?.path ?? null)
          : (state.ancestors[ancestorIndex]?.path ?? null),
      ).join("\n");
      const title = highlightLabel || entry.name;
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
          data-highlight-tone={highlight?.tone}
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
            highlight && `is-highlighted is-highlight-${highlight.tone}`,
          )}
          draggable={!state.busy && renaming?.path !== entry.path}
          onDragStart={(event) => {
            if (panesRef.current[id].state.busy || panesRef.current[id].state.renaming) {
              event.preventDefault();
              return;
            }
            if (ancestorIndex !== undefined) activateColumn(id, ancestorIndex);
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
            clearDragSource();
            setDropTarget(null);
          }}
          onDragOver={(event) => {
            if (state.busy || !entry.isDir || !hasDragPayload(event.dataTransfer)) {
              return;
            }
            event.preventDefault();
            event.stopPropagation();
            const dragged = currentDragSource();
            event.dataTransfer.dropEffect =
              dragged && sameFilesystem(dragged, source) ? "move" : "copy";
            setDropTarget({ pane: id, path: entry.path });
          }}
          onDrop={(event) => {
            if (state.busy || !entry.isDir || !hasDragPayload(event.dataTransfer)) {
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
          <span className={cn("sftp-row__icon", entry.isDir && "is-dir")} title={highlightLabel}>
            <FileTypeIcon
              isDir={entry.isDir}
              icon={entry.isDir ? undefined : resolveFileIcon(entry.name)}
              size={16}
            />
          </span>
          {renaming?.path === entry.path ? (
            <Input
              autoFocus
              className="sftp-row__name"
              aria-label={entry.isDir ? t("sftp.folderName") : t("sftp.fileName")}
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
              data-panel-focus={`file:${id}:rename`}
              onBlur={() => {
                if (!services.preserveDraftOnBlur?.()) patch(id, { renaming: null });
              }}
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
                  bodies.current[id]?.focus({ preventScroll: true });
                }
              }}
            />
          ) : (
            <span className="sftp-row__name" title={title}>
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
        style={
          {
            "--sftp-columns": grid,
            "--sftp-min-width": minimum,
            "--sftp-icon-column": columnIndex("name"),
            "--sftp-name-column": columnIndex("name") + 1,
            "--sftp-type-column": columnIndex("type") || "auto",
            "--sftp-size-column": columnIndex("size") || "auto",
            "--sftp-modified-column": columnIndex("modified") || "auto",
          } as React.CSSProperties
        }
        data-hide-type={!columns.includes("type") || undefined}
        data-hide-size={!columns.includes("size") || undefined}
        data-hide-modified={!columns.includes("modified") || undefined}
        onMouseDown={() => setActive(id)}
        onFocusCapture={() => setActive(id)}
      >
        <header className="sftp-pane__head">
          {!single && (
            <span
              className="sftp-pane__drag"
              draggable={!!state.listing}
              title={t("sftp.detachPanel")}
              aria-label={t("sftp.detachPanel")}
              onDragStart={(event) => {
                if (!state.listing) {
                  event.preventDefault();
                  return;
                }
                const detached = filePaneOptions(id);
                const rect = event.currentTarget.closest(".sftp-pane")?.getBoundingClientRect();
                const token = beginFilePaneDrag(
                  detached.pane,
                  detached.title,
                  () => retainOtherPane(id),
                  rect ? { width: rect.width, height: rect.height } : undefined,
                );
                event.dataTransfer.setData(FILE_PANE_MIME, token);
                event.dataTransfer.effectAllowed = "move";
              }}
              onDragEnd={clearFilePaneDrag}
            >
              <GripVertical size={14} aria-hidden="true" />
            </span>
          )}
          <Select
            label={t("sftp.source")}
            footerAction={{ label: t("sftp.connectRemote"), onSelect: () => setRemotePane(id) }}
            value={keyForSource(source)}
            options={sourceOptions}
            onChange={(value) => chooseSource(id, value)}
          />
          <div className="sftp-pane__actions">
            <div className="sftp-pane__action-group">
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
                  !state.listing ||
                  state.busy ||
                  parentOf(state.listing.path) === state.listing.path
                }
                onClick={() => state.listing && navigate(id, parentOf(state.listing.path))}
              >
                <ArrowUp size={13} />
              </IconButton>
              <IconButton label={t("sftp.refresh")} size="sm" onClick={() => refreshPane(id)}>
                <RotateCw size={13} />
              </IconButton>
            </div>
            <div className="sftp-pane__action-group">
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
            </div>
            <div className="sftp-pane__action-group">
              {!single ? (
                <IconButton
                  label={t("sftp.detachPanel")}
                  size="sm"
                  disabled={!state.listing}
                  onClick={() => {
                    const detached = filePaneOptions(id);
                    const newTabId = services.workspace.openFilePane(detached.pane, detached.title);
                    services.workspace.splitTab(newTabId, "row");
                    retainOtherPane(id);
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
                  const defaults = services.getState().settings;
                  updateView(
                    id,
                    {
                      filesShowHidden: defaults.filesShowHidden,
                      filesFoldersFirst: defaults.filesFoldersFirst,
                      filesSortBy: defaults.filesSortBy,
                      filesSortDirection: defaults.filesSortDirection,
                      filesGroupBy: "none",
                      filesLayout: "details",
                      filesColumns: [...FILE_COLUMNS],
                      filesColumnWidths: {},
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
          </div>
        </header>

        <FilePathBar
          list={fs.list}
          captureKey={`file:${id}`}
          preserveDraftOnBlur={services.preserveDraftOnBlur}
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
          onFinishEditing={() => bodies.current[id]?.focus({ preventScroll: true })}
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
            <SearchField
              data-panel-focus={`file:${id}:filter`}
              aria-label={t("sftp.filterFiles")}
              filterKeys={["name", "ext", "type", "is", "path", "size", "modified"]}
              placeholder={t("sftp.filterPlaceholder")}
              spellCheck={false}
              value={state.filter}
              onChange={(value) => updateView(id, {}, { filter: value })}
              presets={[
                { key: "type", value: "file", label: t("searchUi.file"), exclusive: true },
                { key: "type", value: "folder", label: t("searchUi.folder"), exclusive: true },
                { key: "ext", value: "", label: t("searchUi.extension") },
                { key: "size", value: ">10MB", label: t("searchUi.size") },
                { key: "is", value: "hidden", label: t("searchUi.hidden") },
                { key: "modified", value: "", label: t("searchUi.date") },
                { key: "path", value: "", label: t("searchUi.path") },
              ]}
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
        <FileBrowserSurface
          paneId={`${instanceId}:${id}`}
          tabId={tabId}
          source={source}
          path={state.listing?.path ?? null}
          entries={entries}
          selectedPaths={state.selectedPaths}
          busy={state.busy}
          error={state.error}
          suspended={!!creating || !!renaming}
          actions={{
            validate: () => {
              const current = panesRef.current[id];
              return (
                sameSource(current.source, source) &&
                current.state.listing === state.listing &&
                !current.state.busy &&
                !current.state.creating &&
                !current.state.renaming
              );
            },
            navigate: (path) => navigate(id, path),
            refresh: () => {
              void load(id, requested.current[id].path);
            },
            select: (paths) => {
              patch(id, {
                selectedPaths: [...paths],
                cursor: paths.at(-1) ?? null,
                anchor: paths[0] ?? null,
              });
              setActive(id);
            },
            open: (entry, preview) => (preview ? previewEntry(id, entry) : applyEntry(id, entry)),
          }}
        >
          <div className={columnView ? "sftp-miller" : "sftp-details"}>
            {columnView
              ? state.ancestors.map((listing, columnIndex) => (
                  <div className="sftp-miller__column" key={listing.path}>
                    <div className="sftp-miller__heading" title={listing.path}>
                      {listing.path}
                    </div>
                    <div
                      className={cn(
                        "sftp-pane__body",
                        dropTarget?.pane === id && dropTarget.path === listing.path && "is-drop",
                      )}
                      data-column-path={listing.path}
                      data-panel-scroll={`file:${id}:column:${columnIndex}`}
                      onScroll={(event) =>
                        rememberColumnScroll(id, listing.path, event.currentTarget.scrollTop)
                      }
                      data-panel-focus={`file:${id}:column:${columnIndex}`}
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
                        if (state.busy || !hasDragPayload(event.dataTransfer)) return;
                        event.preventDefault();
                        event.stopPropagation();
                        setDropTarget({ pane: id, path: listing.path });
                        const dragged = currentDragSource();
                        event.dataTransfer.dropEffect =
                          dragged && sameFilesystem(dragged, source) ? "move" : "copy";
                      }}
                      onDrop={(event) => {
                        if (state.busy || !hasDragPayload(event.dataTransfer)) return;
                        event.preventDefault();
                        event.stopPropagation();
                        const payload = readDragPayload(event.dataTransfer);
                        setDropTarget(null);
                        if (payload) handleDrop(id, listing.path, payload);
                      }}
                    >
                      <FileTypeSelect
                        focusKey={`file:${id}:column:${columnIndex}:type`}
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
              className={cn(
                "sftp-pane__scroll",
                columnView && "sftp-miller__column",
                dropTarget?.pane === id && dropTarget.path === "" && "is-drop",
              )}
              key="current"
            >
              {columnView ? (
                <div className="sftp-miller__heading" title={state.listing?.path}>
                  {state.listing?.path}
                </div>
              ) : (
                <table className="sftp-columns" aria-label={t("sftp.sortColumns")}>
                  <thead>
                    <tr>
                      {columns.map((sort) => (
                        <th
                          key={sort}
                          className={`sftp-columns__${sort}`}
                          scope="col"
                          title={t("sftp.columnHeaderHint")}
                          aria-label={t(
                            sort === "name"
                              ? "sftp.sortName"
                              : sort === "type"
                                ? "sftp.sortType"
                                : sort === "size"
                                  ? "sftp.sortSize"
                                  : "sftp.sortModified",
                          )}
                          data-column-key={sort}
                          style={{
                            gridColumn:
                              sort === "name" ? `${columnIndex(sort)} / span 2` : columnIndex(sort),
                          }}
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
                            onPointerDown={(event) => {
                              columnReorder.start(
                                event,
                                (target, after) => {
                                  const current = panesRef.current[id];
                                  if (!sameSource(current.source, source)) return;
                                  const visible = current.view.filesColumns ?? [...FILE_COLUMNS];
                                  if (
                                    !visible.includes(sort) ||
                                    !visible.includes(target as FileColumn)
                                  )
                                    return;
                                  const next = visible.filter((item) => item !== sort);
                                  next.splice(
                                    next.indexOf(target as FileColumn) + Number(after),
                                    0,
                                    sort,
                                  );
                                  updateView(id, { filesColumns: next });
                                },
                                event.currentTarget.closest<HTMLElement>(".sftp-pane__scroll"),
                              );
                            }}
                            onClick={(event) => {
                              if (columnReorder.suppressClick(event)) return;
                              updateView(id, {
                                filesSortBy: sort,
                                filesSortDirection:
                                  view.filesSortBy === sort && view.filesSortDirection === "asc"
                                    ? "desc"
                                    : "asc",
                              });
                            }}
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
                                className={
                                  view.filesSortDirection === "desc" ? "is-desc" : undefined
                                }
                                aria-hidden="true"
                              />
                            ) : null}
                          </button>
                          <span
                            className="sftp-columns__resize"
                            role="separator"
                            aria-orientation="vertical"
                            tabIndex={0}
                            aria-valuemin={56}
                            aria-valuemax={1000}
                            aria-valuenow={
                              view.filesColumnWidths?.[sort] ?? DEFAULT_COLUMN_WIDTHS[sort]
                            }
                            aria-label={`${t("sftp.sortColumns")}: ${t(sort === "name" ? "sftp.sortName" : sort === "type" ? "sftp.sortType" : sort === "size" ? "sftp.sortSize" : "sftp.sortModified")}`}
                            onDragStart={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                            }}
                            onDoubleClick={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              updateView(id, {
                                filesColumnWidths: {
                                  ...view.filesColumnWidths,
                                  [sort]: fitFileColumn(event.currentTarget.closest("th")!, sort),
                                },
                              });
                            }}
                            title={t("sftp.resizeColumnHint")}
                            onPointerDown={(event) => resizeColumn(sort, event)}
                            onKeyDown={(event) => {
                              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                              event.preventDefault();
                              event.stopPropagation();
                              const current =
                                view.filesColumnWidths?.[sort] ?? DEFAULT_COLUMN_WIDTHS[sort];
                              const delta =
                                (event.key === "ArrowLeft" ? -1 : 1) * (event.shiftKey ? 50 : 10);
                              updateView(id, {
                                filesColumnWidths: {
                                  ...view.filesColumnWidths,
                                  [sort]: Math.max(56, Math.min(1000, current + delta)),
                                },
                              });
                            }}
                          />
                        </th>
                      ))}
                    </tr>
                  </thead>
                </table>
              )}

              <div
                data-panel-scroll={`file:${id}:body`}
                data-panel-focus={`file:${id}:body`}
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
                  if (state.busy || !hasDragPayload(event.dataTransfer)) {
                    return;
                  }
                  event.preventDefault();
                  const dragged = currentDragSource();
                  event.dataTransfer.dropEffect =
                    dragged && sameFilesystem(dragged, source) ? "move" : "copy";
                  setDropTarget({ pane: id, path: "" });
                }}
                onDragLeave={(event) => {
                  if (
                    !(event.relatedTarget instanceof Node) ||
                    !event.currentTarget.contains(event.relatedTarget)
                  )
                    setDropTarget(null);
                }}
                onDrop={(event) => {
                  if (state.busy || !hasDragPayload(event.dataTransfer)) return;
                  event.preventDefault();
                  event.stopPropagation();
                  const payload = readDragPayload(event.dataTransfer);
                  setDropTarget(null);
                  if (payload && state.listing) {
                    handleDrop(id, state.listing.path, payload);
                  }
                }}
              >
                <FileTypeSelect
                  focusKey={`file:${id}:type`}
                  onText={(text, at) => selectByText(id, text, at)}
                />
                {state.error ? <p className="sftp-pane__error">{state.error}</p> : null}
                {!state.busy && state.listing && fileView.total === 0 && !creating ? (
                  <p className="sftp-pane__empty">
                    {t(
                      state.filter || state.filterKind !== "all" ? "sftp.noMatches" : "sftp.empty",
                    )}
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
                      data-panel-focus={`file:${id}:create`}
                      onBlur={() => {
                        if (!services.preserveDraftOnBlur?.()) patch(id, { creating: null });
                      }}
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
                          bodies.current[id]?.focus({ preventScroll: true });
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
        </FileBrowserSurface>
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
    </div>
  );
  /* eslint-enable react-hooks/refs */
}
