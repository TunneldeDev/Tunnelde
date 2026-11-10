import type {
  FrontendFileBrowser,
  FrontendFileBrowserSnapshot,
  FrontendFileEntry,
} from "./contracts/files/browser";

export interface FileBrowserActions {
  /** Recheck synchronous host state, including pending navigation, before dispatch. */
  validate?(): boolean;
  navigate(path: string): void;
  refresh(): void;
  select(paths: readonly string[]): void;
  open(entry: FrontendFileEntry, preview: boolean): void;
}

/** Project once per visible listing, not on every selection/loading update. */
export function createFileBrowserListing(entries: readonly FrontendFileEntry[]) {
  const rows = entries.map((entry) =>
    Object.freeze({
      name: entry.name,
      path: entry.path,
      isDir: entry.isDir,
      isHidden: entry.isHidden,
      size: entry.size,
      modified: entry.modified,
      permissions: entry.permissions,
    }),
  );
  const total = rows.length;
  const available = new Map(rows.map((entry) => [entry.path, entry]));
  return Object.freeze({
    total,
    entry: (path: string) => available.get(path),
    page: (offset: number, end: number) => Object.freeze(rows.slice(offset, end)),
  });
}

/** One immutable revision. Callers fence source changes, unmounts and provider revocation. */
export function createFileBrowserContext(
  snapshot: FrontendFileBrowserSnapshot,
  entries: readonly FrontendFileEntry[] | ReturnType<typeof createFileBrowserListing>,
  live: () => void,
  actions: FileBrowserActions,
): Omit<FrontendFileBrowser, "Entries"> {
  const listing = Array.isArray(entries)
    ? createFileBrowserListing(entries)
    : (entries as ReturnType<typeof createFileBrowserListing>);
  const total = listing.total;
  const data = Object.freeze({
    paneId: snapshot.paneId,
    revision: snapshot.revision,
    source: Object.freeze(
      snapshot.source.kind === "local"
        ? { kind: "local" as const }
        : { kind: "remote" as const, sessionId: snapshot.source.sessionId },
    ),
    path: snapshot.path,
    total,
    selectedPaths: Object.freeze([...snapshot.selectedPaths]),
    busy: snapshot.busy,
    error: snapshot.error,
  });
  const ready = () => {
    live();
    if (actions.validate && !actions.validate()) throw new Error("plugin.fileBrowser.changed");
    if (data.busy || !data.path) throw new Error("plugin.fileBrowser.busy");
  };
  return Object.freeze({
    snapshot: data,
    read: ({ revision, offset = 0 }: { revision: string; offset?: number }) => {
      // Reading is pure, including during the provider's first render. A retained
      // context reads its immutable revision; only live contexts can dispatch actions.
      if (revision !== data.revision) throw new Error("plugin.fileBrowser.changed");
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > total)
        throw new Error("plugin.fileBrowser.invalid");
      const next = Math.min(total, offset + 256);
      return Object.freeze({
        revision,
        total,
        nextOffset: next < total ? next : null,
        items: listing.page(offset, next),
      });
    },
    navigate: (path: string) => {
      ready();
      if (typeof path !== "string" || !path.trim() || path.length > 32768 || /[\0\r\n]/.test(path))
        throw new Error("plugin.fileBrowser.invalid");
      actions.navigate(path);
    },
    refresh: () => {
      ready();
      actions.refresh();
    },
    select: (paths: readonly string[]) => {
      ready();
      if (
        !Array.isArray(paths) ||
        paths.length > total ||
        new Set(paths).size !== paths.length ||
        paths.some((path) => !listing.entry(path))
      )
        throw new Error("plugin.fileBrowser.invalid");
      actions.select([...paths]);
    },
    open: (path: string, mode: "open" | "preview" = "open") => {
      ready();
      const entry = listing.entry(path);
      if (!entry || !["open", "preview"].includes(mode))
        throw new Error("plugin.fileBrowser.invalid");
      if (entry.isDir) {
        if (mode === "preview") throw new Error("plugin.fileBrowser.invalid");
        actions.navigate(entry.path);
      } else actions.open({ ...entry }, mode === "preview");
    },
  });
}
