import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ProviderSurface } from "@/components/layout/ProviderSurface";
import { createPersistentSurface } from "@/lib/extensions/persistentSurface";
import { createProcessesContext } from "@/lib/extensions/monitor/processes/context";
import { useSsh } from "@/store/ssh";
import type { ProcessManager } from "../runtime/useManager";

export function ProcessesSurface({
  manager,
  children,
}: {
  manager: ProcessManager;
  children: ReactNode;
}) {
  const [surface] = useState(createPersistentSurface);
  const Entries = surface.Mount;
  const session = useSsh((state) => state.sessions.find((item) => item.id === manager.sessionId));
  // Rows and selection retire the previous public revision.
  const frame = useMemo(
    () => ({
      sessionId: manager.sessionId,
      hostId: session?.hostId ?? "",
      title: session?.title ?? "",
      revision: crypto.randomUUID(),
      rowIdentity: manager.filtered,
      selectionIdentity: manager.selected,
      query: manager.query,
      sort: manager.sort,
      busy: manager.loading,
      stopping: manager.stopping,
      paused: manager.paused,
      updatedAt: manager.updatedAt,
      error: manager.error,
    }),
    [
      manager.sessionId,
      session?.hostId,
      session?.title,
      manager.query,
      manager.sort,
      manager.loading,
      manager.stopping,
      manager.paused,
      manager.updatedAt,
      manager.error,
      // Query rows and selection also own a new revision, even if status is unchanged.
      manager.filtered,
      manager.selected,
    ],
  );
  const committed = useRef<object | null>(null);
  useLayoutEffect(() => {
    committed.current = frame;
    return () => {
      committed.current = null;
    };
  }, [frame]);
  /* eslint-disable react-hooks/refs -- Factory captures checks; no ref is read during render. */
  const context = useMemo(
    () =>
      Object.freeze({
        Entries,
        ...createProcessesContext(frame, manager.filtered, manager.selected, {
          validate: () => committed.current === frame && manager.validate(),
          setQuery: manager.setQuery,
          setSort: manager.setSort,
          select: manager.select,
          refresh: manager.refresh,
          setPaused: manager.setPaused,
          requestTerminate: manager.requestTerminate,
        }),
      }),
    [Entries, frame, manager],
  );
  /* eslint-enable react-hooks/refs */
  return (
    <div className="process-surface">
      <ProviderSurface target="processes" processes={context}>
        <Entries />
      </ProviderSurface>
      {createPortal(children, surface.container)}
    </div>
  );
}
