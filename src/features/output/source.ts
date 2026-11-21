import { createStore } from "zustand/vanilla";
import { create } from "zustand";
import { api, isTauri, type OutputCursor } from "@/lib/api/ipc";
import { translateError } from "@/lib/api/errors";
import { boundOutput, snapshotEntries, type OutputEntry } from "./model";

/** One reader per coordinator, independent of where the output view is hosted.
 * Local standalone previews get an isolated reader; satellites never start a reader.
 */
export function createOutputSource() {
  const store = createStore(() => ({ entries: [] as OutputEntry[], truncated: false, error: "" }));
  const readers = new Map<symbol, boolean>();
  let cursor: OutputCursor | null = null;
  let sequence = 0,
    clearSerial = 0,
    disposed = false,
    refreshQueued = false;
  let pending: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const active = () => !disposed && readers.size > 0 && isTauri();
  const readable = () => active() && (!document.hidden || [...readers.values()].some(Boolean));
  const poll = (): Promise<void> => {
    if (!readable()) {
      if (active()) {
        clearTimeout(timer);
        timer = setTimeout(() => {
          void poll().catch(() => {});
        }, 2000);
      }
      return Promise.resolve();
    }
    if (pending) {
      refreshQueued = true;
      return pending;
    }
    clearTimeout(timer);
    const serial = clearSerial;
    pending = (async () => {
      try {
        const result = await Promise.resolve().then(() => api.logsOutputRead(cursor));
        if (disposed) return;
        cursor = result.cursor;
        const added = snapshotEntries(result, () => ++sequence);
        const previous = store.getState();
        if (serial === clearSerial && (added.length || result.truncated)) {
          const bounded = boundOutput([...previous.entries, ...added]);
          store.setState({
            entries: bounded.entries,
            truncated: previous.truncated || bounded.omitted || result.truncated,
          });
        }
        store.setState({ error: "" });
      } catch (error) {
        if (!disposed) store.setState({ error: translateError(error) });
        throw error;
      } finally {
        pending = null;
        if (active()) {
          clearTimeout(timer);
          const soon = refreshQueued;
          refreshQueued = false;
          timer = setTimeout(
            () => {
              void poll().catch(() => {});
            },
            soon ? 0 : 2000,
          );
        }
      }
    })();
    return pending;
  };
  return {
    store,
    retain(background = false) {
      if (disposed) throw new Error("panel.window.disposed");
      const token = Symbol("output-reader");
      readers.set(token, background);
      if (readers.size === 1 || (background && document.hidden)) void poll().catch(() => {});
      return () => {
        readers.delete(token);
        if (!readers.size) clearTimeout(timer);
      };
    },
    refresh: poll,
    clear() {
      clearSerial++;
      store.setState({ entries: [], truncated: false });
    },
    dispose() {
      disposed = true;
      readers.clear();
      clearTimeout(timer);
    },
  };
}
export type OutputSource = ReturnType<typeof createOutputSource>;
export const useOutputSource = create<{ source: OutputSource | null }>(() => ({ source: null }));
export function installOutputSource(source: OutputSource) {
  useOutputSource.setState({ source });
  return () => {
    if (useOutputSource.getState().source === source) useOutputSource.setState({ source: null });
  };
}
