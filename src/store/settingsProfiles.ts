import { create } from "zustand";
import { api, isTauri } from "@/lib/api/ipc";
import type { PortableSettings, SettingsProfile } from "@/lib/prefs/profiles";
import { translateError } from "@/lib/api/errors";
import { toast } from "@/store/toasts";

interface ProfilesStore {
  profiles: SettingsProfile[];
  selectedId: string | null;
  loading: boolean;
  busy: boolean;
  error: string | null;
  load: () => Promise<void>;
  select: (id: string | null) => void;
  save: (id: string | null, name: string, settings: PortableSettings) => Promise<boolean>;
  remove: (id: string) => Promise<boolean>;
}

export const useSettingsProfiles = create<ProfilesStore>((set, get) => {
  let loading: Promise<void> | null = null;
  let revision = 0;
  const change = async (run: () => Promise<SettingsProfile[]>, selectedId?: string | null) => {
    if (get().busy) return false;
    revision++;
    set({ busy: true, error: null });
    try {
      const profiles = await run();
      set({ profiles, ...(selectedId !== undefined ? { selectedId } : {}) });
      return true;
    } catch (failure) {
      const error = translateError(failure);
      set({ error });
      toast(error, "error");
      return false;
    } finally {
      set({ busy: false });
    }
  };
  return {
    profiles: [],
    selectedId: null,
    loading: false,
    busy: false,
    error: null,
    load: () => {
      if (loading) return loading;
      if (!isTauri()) return Promise.resolve();
      const started = revision;
      set({ loading: true });
      loading = api
        .settingsProfiles()
        .then((profiles) => {
          if (started === revision) set({ profiles, error: null });
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
    select: (selectedId) => set({ selectedId }),
    save: async (id, name, settings) => {
      const ok = await change(() => api.saveSettingsProfile(id, name, settings));
      if (ok && id === null)
        set({
          selectedId: get().profiles.find((profile) => profile.name === name.trim())?.id ?? null,
        });
      return ok;
    },
    remove: (id) =>
      change(() => api.deleteSettingsProfile(id), get().selectedId === id ? null : undefined),
  };
});
