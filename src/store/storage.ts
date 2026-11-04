import { create } from "zustand";
import { api, isTauri } from "@/lib/api/ipc";
import { translateError } from "@/lib/api/errors";
import type { StorageChange, StorageStatus } from "@/lib/api/storage";

interface StorageStore {
  status: StorageStatus | null;
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
  const change = async (run: () => Promise<StorageStatus>) => {
    if (get().busy) return false;
    revision++;
    set({ busy: true, error: null });
    try {
      set({ status: await run() });
      return true;
    } catch (failure) {
      set({ error: translateError(failure) });
      return false;
    } finally {
      set({ busy: false });
    }
  };
  return {
    status: null,
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
          if (started === revision) set({ status, error: null });
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
