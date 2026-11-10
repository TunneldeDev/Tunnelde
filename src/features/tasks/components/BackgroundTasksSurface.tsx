import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ProviderSurface } from "@/components/layout/ProviderSurface";
import { createPersistentSurface } from "@/lib/extensions/persistentSurface";
import { createBackgroundTasksContext } from "@/lib/extensions/backgroundTasks/context";
import { useBackgroundTasks } from "@/lib/tasks/registry";
import type { BackgroundTaskEntry } from "@/lib/tasks/model";

export function BackgroundTasksSurface({
  entries,
  embedded,
  visible,
  children,
}: {
  entries: readonly BackgroundTaskEntry[];
  embedded: boolean;
  visible: boolean;
  children: ReactNode;
}) {
  const [surface] = useState(createPersistentSurface);
  const Entries = surface.Mount;
  const frame = useMemo(
    () => ({
      revision: crypto.randomUUID(),
      presentation: embedded ? ("embedded" as const) : ("floating" as const),
    }),
    // Every task publication or visibility transition retires the previous action frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [entries, embedded, visible],
  );
  const committed = useRef<object | null>(null);
  useLayoutEffect(() => {
    committed.current = frame;
    return () => {
      committed.current = null;
    };
  }, [frame]);
  /* eslint-disable react-hooks/refs -- Factories retain callbacks for later user operations. */
  const context = useMemo(
    () =>
      Object.freeze({
        Entries,
        ...createBackgroundTasksContext(
          frame,
          entries,
          () =>
            visible &&
            committed.current === frame &&
            useBackgroundTasks.getState().items === entries,
        ),
      }),
    [Entries, frame, entries, visible],
  );
  /* eslint-enable react-hooks/refs */
  return (
    <div className="background-tasks-surface">
      <ProviderSurface target="backgroundTasks" backgroundTasks={context} visible={visible}>
        <Entries />
      </ProviderSurface>
      {createPortal(children, surface.container)}
    </div>
  );
}
