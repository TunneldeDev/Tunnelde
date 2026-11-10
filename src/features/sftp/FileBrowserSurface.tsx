import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ProviderSurface } from "@/components/layout/ProviderSurface";
import type { FileEntry, FsSource } from "@/lib/api/types";
import {
  createFileBrowserContext,
  createFileBrowserListing,
  type FileBrowserActions,
} from "@/lib/extensions/fileBrowser";
import { createPersistentSurface } from "@/lib/extensions/persistentSurface";

/** Keeps file ownership, navigation, filtering and native recovery outside the provider. */
export function FileBrowserSurface({
  paneId,
  source,
  path,
  entries,
  selectedPaths,
  busy,
  error,
  suspended,
  actions,
  children,
}: {
  paneId: string;
  source: FsSource;
  path: string | null;
  entries: readonly FileEntry[];
  selectedPaths: readonly string[];
  busy: boolean;
  error: string | null;
  suspended: boolean;
  actions: FileBrowserActions;
  children: ReactNode;
}) {
  const current = useRef<{ frame: object; actions: FileBrowserActions } | null>(null);
  const [surface] = useState(createPersistentSurface);
  const Entries = surface.Mount;
  const listing = useMemo(() => createFileBrowserListing(entries), [entries]);
  const frame = useMemo(
    () => ({
      paneId,
      revision: crypto.randomUUID(),
      source,
      path,
      total: entries.length,
      selectedPaths,
      busy: busy || suspended,
      error,
    }),
    [paneId, source, path, entries, selectedPaths, busy, error, suspended],
  );
  useLayoutEffect(() => {
    current.current = { frame, actions };
    return () => {
      current.current = null;
    };
  }, [frame, actions]);
  /* eslint-disable react-hooks/refs -- The pure factory stores these callbacks; it never calls them during render. */
  const context = useMemo(() => {
    const live = () => {
      if (current.current?.frame !== frame) throw new Error("plugin.fileBrowser.changed");
    };
    return Object.freeze({
      Entries: surface.Mount,
      ...createFileBrowserContext(frame, listing, live, {
        validate: () => current.current!.actions.validate?.() ?? true,
        navigate: (path) => current.current!.actions.navigate(path),
        refresh: () => current.current!.actions.refresh(),
        select: (paths) => current.current!.actions.select(paths),
        open: (entry, preview) => current.current!.actions.open(entry, preview),
      }),
    });
  }, [frame, listing, surface]);
  /* eslint-enable react-hooks/refs */
  return (
    <>
      <ProviderSurface target="fileBrowser" fileBrowser={context} suspended={suspended}>
        <Entries />
      </ProviderSurface>
      {createPortal(children, surface.container)}
    </>
  );
}
