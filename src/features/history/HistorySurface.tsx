import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ProviderSurface } from "@/components/layout/ProviderSurface";
import {
  createHistoryContext,
  type HistoryActions,
  type HistoryRow,
} from "@/lib/extensions/history/context";
import { createPersistentSurface } from "@/lib/extensions/persistentSurface";

/** Host toolbar, data loading and confirmations remain outside plugin presentation. */
export function HistorySurface({
  sessionId,
  hostId,
  title,
  query,
  entries,
  busy,
  error,
  actions,
  children,
}: {
  sessionId: string;
  hostId: string;
  title: string;
  query: string;
  entries: readonly HistoryRow[];
  busy: boolean;
  error: string | null;
  actions: HistoryActions;
  children: ReactNode;
}) {
  const current = useRef<{ frame: object; actions: HistoryActions } | null>(null);
  const [surface] = useState(createPersistentSurface);
  const Entries = surface.Mount;
  const frame = useMemo(
    () => ({
      sessionId,
      hostId,
      title,
      query,
      revision: crypto.randomUUID(),
      total: entries.length,
      busy,
      error,
    }),
    [sessionId, hostId, title, query, entries, busy, error],
  );
  useLayoutEffect(() => {
    current.current = { frame, actions };
    return () => {
      current.current = null;
    };
  }, [frame, actions]);
  /* eslint-disable react-hooks/refs -- Pure factory stores callbacks, never invokes them during render. */
  const context = useMemo(
    () =>
      Object.freeze({
        Entries: surface.Mount,
        ...createHistoryContext(
          frame,
          entries,
          () => {
            if (current.current?.frame !== frame) throw new Error("plugin.history.changed");
          },
          {
            validate: () => current.current!.actions.validate(),
            setQuery: (value) => current.current!.actions.setQuery(value),
            refresh: () => current.current!.actions.refresh(),
            delete: (entry) => current.current!.actions.delete(entry),
            requestClear: (authorize) => current.current!.actions.requestClear(authorize),
            execute: (entry) => current.current!.actions.execute(entry),
          },
        ),
      }),
    [frame, entries, surface],
  );
  /* eslint-enable react-hooks/refs */
  return (
    <>
      <ProviderSurface target="history" history={context}>
        <Entries />
      </ProviderSurface>
      {createPortal(children, surface.container)}
    </>
  );
}
