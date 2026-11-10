/** Committed list data with one trailing read, stale-lifetime fencing and retained error recovery. */
export function createInvalidatedListStore<T>(
  load: () => Promise<T[]>,
  report: (error: unknown) => void,
) {
  let snapshot: Readonly<{
    entries: readonly T[] | null;
    busy: boolean;
    error: unknown;
  }> = Object.freeze({ entries: null, busy: true, error: null });
  const listeners = new Set<() => void>();
  let generation = 0,
    lifetime = 0,
    requested = 0,
    running = false,
    loading = false;
  const publish = (next: typeof snapshot) => {
    snapshot = Object.freeze(next);
    for (const receive of [...listeners]) receive();
  };
  const refresh = () => {
    if (!running) return;
    requested++;
    if (loading) return;
    loading = true;
    const ownGeneration = generation;
    let completed = requested;
    publish({ ...snapshot, busy: true, error: null });
    void (async () => {
      while (running && generation === ownGeneration) {
        const ownRequest = requested;
        try {
          const entries = await load();
          if (!running || generation !== ownGeneration) return;
          // A committed write during the request requires a fresh read before publishing.
          if (ownRequest !== requested) continue;
          completed = ownRequest;
          publish({ entries, busy: false, error: null });
        } catch (error) {
          if (!running || generation !== ownGeneration) return;
          if (ownRequest !== requested) continue;
          completed = ownRequest;
          publish({ ...snapshot, busy: false, error });
          report(error);
        }
        break;
      }
    })().finally(() => {
      if (generation === ownGeneration) {
        loading = false;
        if (running && completed !== requested) refresh();
      }
    });
  };
  return Object.freeze({
    getSnapshot: () => snapshot,
    subscribe: (receive: () => void) => {
      listeners.add(receive);
      return () => {
        listeners.delete(receive);
      };
    },
    refresh,
    // A successful mutation supplies authoritative rows even if an older read is stuck.
    accept: (project: (entries: readonly T[]) => readonly T[]) => {
      const entries = project(snapshot.entries ?? []);
      generation++;
      loading = false;
      publish({ entries, busy: false, error: null });
      refresh();
    },
    reset: () => {
      generation++;
      loading = false;
      publish({ entries: null, busy: true, error: null });
    },
    start: () => {
      const ownLifetime = ++lifetime;
      generation++;
      running = true;
      loading = false;
      refresh();
      return () => {
        if (lifetime !== ownLifetime) return;
        generation++;
        running = false;
        loading = false;
      };
    },
  });
}
