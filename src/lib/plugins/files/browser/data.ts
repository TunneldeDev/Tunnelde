import type {
  FileBrowserMetadata,
  FileBrowserObservation,
  FileBrowserPage,
} from "@/lib/extensions/contracts/files/browser/data";
import { fileBrowserCatalogue, liveFileBrowser } from "@/lib/files/browser/registry";
import { bytes, errorText, integer, object, page, path, token } from "./validation";

/** The observation describes one captured UI state, never an atomic filesystem snapshot. */
export async function observeFileBrowsers(input: unknown): Promise<FileBrowserObservation> {
  const request = object(input, ["offset", "limit", "revision"]);
  const offset = integer(request.offset, 0, Number.MAX_SAFE_INTEGER);
  const limit = integer(request.limit, 16, 32);
  if (limit < 1) throw new Error("plugin.fileBrowser.invalid");
  if (Object.hasOwn(request, "revision")) token(request.revision);
  const catalogue = fileBrowserCatalogue();
  if (offset > catalogue.items.length) throw new Error("plugin.fileBrowser.invalid");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify([catalogue.revision, offset, limit])),
  );
  const revision = Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
  if (revision === request.revision) return { schemaVersion: 1, revision, changed: false };
  const rows: FileBrowserMetadata[] = catalogue.items
    .slice(offset, offset + limit)
    .map(({ browser, tabId, suspended }) => {
      const snapshot = browser.snapshot;
      token(snapshot.paneId);
      token(snapshot.revision);
      if (snapshot.path !== null) path(snapshot.path);
      if (tabId !== null) token(tabId);
      integer(snapshot.total, 0, Number.MAX_SAFE_INTEGER);
      integer(snapshot.selectedPaths.length, 0, Number.MAX_SAFE_INTEGER);
      const source =
        snapshot.source.kind === "local"
          ? Object.freeze({ kind: "local" as const })
          : Object.freeze({ kind: "remote" as const, sessionId: token(snapshot.source.sessionId) });
      return Object.freeze({
        paneId: snapshot.paneId,
        tabId,
        revision: snapshot.revision,
        source,
        path: snapshot.path,
        total: snapshot.total,
        selectedCount: snapshot.selectedPaths.length,
        busy: snapshot.busy,
        suspended,
        ...errorText(snapshot.error),
      });
    });
  const bounded = page(rows, 0, limit);
  const end = offset + bounded.items.length;
  return {
    schemaVersion: 1,
    revision,
    changed: true,
    snapshot: {
      total: catalogue.items.length,
      offset,
      nextOffset: end < catalogue.items.length ? end : null,
      items: bounded.items,
    },
  };
}

export function readFileBrowser(input: unknown): FileBrowserPage {
  const request = object(input, ["paneId", "revision", "offset", "limit"]);
  const paneId = token(request.paneId),
    revision = token(request.revision);
  const offset = integer(request.offset, 0, Number.MAX_SAFE_INTEGER);
  const limit = integer(request.limit, 64, 256);
  if (limit < 1) throw new Error("plugin.fileBrowser.invalid");
  const { browser } = liveFileBrowser(paneId, revision);
  const result = browser.read({ revision, offset });
  const selected = new Set(browser.snapshot.selectedPaths);
  const rows = result.items.slice(0, limit).map((entry) => {
    path(entry.path);
    if (
      typeof entry.name !== "string" ||
      bytes(entry.name) > 4096 ||
      /[\0\p{Cs}]/u.test(entry.name)
    )
      throw new Error("plugin.fileBrowser.invalid");
    if (
      typeof entry.isDir !== "boolean" ||
      typeof entry.isHidden !== "boolean" ||
      !Number.isSafeInteger(entry.size) ||
      entry.size < 0 ||
      (entry.modified !== null && !Number.isSafeInteger(entry.modified)) ||
      (entry.permissions !== null &&
        (!Number.isSafeInteger(entry.permissions) ||
          entry.permissions < 0 ||
          entry.permissions > 0xffffffff))
    )
      throw new Error("plugin.fileBrowser.invalid");
    return Object.freeze({
      name: entry.name,
      path: entry.path,
      isDir: entry.isDir,
      isHidden: entry.isHidden,
      size: entry.size,
      modified: entry.modified,
      permissions: entry.permissions,
      selected: selected.has(entry.path),
    });
  });
  const bounded = page(rows, 0, limit);
  const end = offset + bounded.items.length;
  return {
    schemaVersion: 1,
    paneId,
    revision,
    total: result.total,
    offset,
    nextOffset: end < result.total ? end : null,
    items: bounded.items,
  };
}
