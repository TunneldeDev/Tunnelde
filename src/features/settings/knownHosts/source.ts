import { create } from "zustand";
import { createStore } from "zustand/vanilla";
import { api } from "@/lib/api/ipc";
import { translateError } from "@/lib/api/errors";
import type { KnownHostEntry } from "@/lib/api/types";

export interface KnownHostsData {
  entries: KnownHostEntry[];
  loading: boolean;
  error: string;
}
export function createKnownHostsSource() {
  const store = createStore<KnownHostsData>(() => ({ entries: [], loading: true, error: "" }));
  let version = 0,
    disposed = false;
  const readers = new Set<symbol>();
  let pending: Promise<void> | undefined;
  const refresh = (): Promise<void> => {
    if (disposed) return Promise.reject(new Error("panel.window.disposed"));
    if (pending) return pending;
    const serial = ++version;
    store.setState({ loading: true, error: "" });
    pending = Promise.resolve()
      .then(() => api.knownHostsList())
      .then((entries) => {
        if (!disposed && serial === version)
          store.setState({
            entries: entries.map(({ host, port, algorithm, fingerprint, updatedAt }) => ({
              host,
              port,
              algorithm,
              fingerprint,
              updatedAt,
            })),
          });
      })
      .catch((error: unknown) => {
        if (!disposed && serial === version) store.setState({ error: translateError(error) });
        throw error;
      })
      .finally(() => {
        if (serial === version) {
          pending = undefined;
          if (!disposed) store.setState({ loading: false });
        }
      });
    return pending;
  };
  return {
    store,
    refresh,
    retain() {
      if (disposed) throw new Error("panel.window.disposed");
      const token = Symbol("known-host-reader");
      readers.add(token);
      if (readers.size === 1) void refresh().catch(() => {});
      return () => {
        readers.delete(token);
      };
    },
    async forget(entry: KnownHostEntry) {
      if (disposed) throw new Error("panel.window.disposed");
      await api.knownHostsForget(entry.host, entry.port, entry);
      if (disposed) return;
      // An older in-flight list must not resurrect the deleted key. The new
      // read is independent; a list failure does not undo a successful removal.
      version++;
      pending = undefined;
      store.setState(({ entries }) => ({
        entries: entries.filter((item) => item.host !== entry.host || item.port !== entry.port),
      }));
      void refresh().catch(() => {});
    },
    dispose() {
      disposed = true;
      version++;
      readers.clear();
    },
  };
}
export type KnownHostsSource = ReturnType<typeof createKnownHostsSource>;
export const useKnownHostsSource = create<{ source: KnownHostsSource | null }>(() => ({
  source: null,
}));
export function installKnownHostsSource(source: KnownHostsSource) {
  useKnownHostsSource.setState({ source });
  return () => {
    if (useKnownHostsSource.getState().source === source)
      useKnownHostsSource.setState({ source: null });
  };
}
