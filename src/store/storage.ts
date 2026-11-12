import { create } from "zustand";
import { api, isTauri } from "@/lib/api/ipc";
import { translateError } from "@/lib/api/errors";
import type { StorageChange, StorageStatus } from "@/lib/api/storage";

interface StorageStore {
  status: StorageStatus | null;
  restartPending: boolean;
  loadRestartPending: () => Promise<void>;
  refreshMetadata: (signal?: AbortSignal) => Promise<void>;
  loading: boolean;
  busy: boolean;
  error: string | null;
  draft: StorageChange[];
  setDraft: (next: StorageChange[] | ((previous: StorageChange[]) => StorageChange[])) => void;
  load: () => Promise<void>;
  schedule: (changes: StorageChange[]) => Promise<boolean>;
  cancel: () => Promise<boolean>;
}

export const useStorage = create<StorageStore>((set, get) => {
  let loading: Promise<void> | null = null;
  let revision = 0;
  let pendingRead = 0;
  const readRestartPending = async (signal?: AbortSignal) => {
    if (!isTauri() || signal?.aborted) return;
    const started = revision;
    const read = ++pendingRead;
    const restartPending = await api.storageRestartPending();
    if (!signal?.aborted && started === revision && read === pendingRead) set({ restartPending });
  };
  const change = async (run: () => Promise<StorageStatus>) => {
    if (get().busy) return false;
    revision++;
    set({ busy: true, error: null });
    try {
      const status = await run();
      set({ status, restartPending: !!status.pending });
      return true;
    } catch (failure) {
      set({ error: translateError(failure) });
      // A failed cancellation can already have persisted its recovery direction.
      // Read it back so the view cannot keep promising an ordinary migration.
      try {
        const status = await api.storageStatus();
        set({ status, restartPending: !!status.pending });
      } catch {
        // Preserve the original operation error when recovery metadata is unavailable.
      }
      return false;
    } finally {
      revision++;
      set({ busy: false });
    }
  };
  return {
    status: null,
    restartPending: false,
    loadRestartPending: async () => {
      try {
        await readRestartPending();
      } catch (failure) {
        console.warn("Could not check pending storage changes", failure);
      }
    },
    refreshMetadata: async (signal) => {
      if (signal?.aborted) return;
      revision++;
      // Propagate failures so bridge recovery can retry its authoritative read.
      await readRestartPending(signal);
    },
    loading: false,
    busy: false,
    error: null,
    draft: [],
    setDraft: (next) => set({ draft: typeof next === "function" ? next(get().draft) : next }),
    load: () => {
      if (loading) return loading;
      if (!isTauri() || get().busy) return Promise.resolve();
      const started = revision;
      set({ loading: true });
      loading = api
        .storageStatus()
        .then((status) => {
          if (started === revision) set({ status, restartPending: !!status.pending, error: null });
        })
        .catch((failure: unknown) => {
          if (started === revision) set({ error: translateError(failure) });
        })
        .finally(() => {
          loading = null;
          set({ loading: false });
        });
      return loading;
    },
    schedule: async (changes) => {
      const ok = await change(() => api.storageSchedule(changes));
      if (ok) set({ draft: [] });
      return ok;
    },
    cancel: () => change(api.storageCancel),
  };
});
