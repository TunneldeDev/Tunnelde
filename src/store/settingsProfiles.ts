import { create } from "zustand";
import { api, isTauri } from "@/lib/api/ipc";
import type { PortableSettings, SettingsProfile } from "@/lib/prefs/profiles";
import { translateError } from "@/lib/api/errors";
import { toast } from "@/store/toasts";

interface ProfilesStore {
  profiles: SettingsProfile[];
  revision: string | null;
  selectedId: string | null;
  loading: boolean;
  busy: boolean;
  error: string | null;
  load: () => Promise<void>;
  refresh: () => Promise<void>;
  save: (id: string | null, name: string, settings: PortableSettings) => Promise<boolean>;
  remove: (id: string) => Promise<boolean>;
}

export const useSettingsProfiles = create<ProfilesStore>((set, get) => {
  let loading: Promise<void> | null = null;
  let generation = 0;
  let requested = false;
  let opened = false;
  const load = (): Promise<void> => {
    if (!isTauri()) return Promise.resolve();
    opened = true;
    if (loading) return loading;
    if (get().busy) {
      requested = true;
      return Promise.resolve();
    }
    set({ loading: true });
    loading = (async () => {
      do {
        requested = false;
        const started = generation;
        try {
          const snapshot = await api.settingsProfilesSnapshot();
          if (started === generation && !get().busy) {
            set({
              profiles: snapshot.profiles,
              revision: snapshot.revision,
              selectedId: snapshot.activeId,
              error: null,
            });
          }
        } catch (failure) {
          if (started === generation && !get().busy) set({ error: translateError(failure) });
        }
      } while (requested && !get().busy);
    })().finally(() => {
      loading = null;
      set({ loading: false });
    });
    return loading;
  };
  const change = async (run: () => Promise<SettingsProfile[]>) => {
    if (get().busy) return false;
    generation++;
    requested = true;
    set({ busy: true, error: null });
    let changed = false;
    try {
      const profiles = await run();
      changed = true;
      // Legacy array responses remain compatible; a fresh snapshot supplies
      // the authoritative selection and content revision.
      set({
        profiles,
        revision: null,
        selectedId: profiles.some((profile) => profile.id === get().selectedId)
          ? get().selectedId
          : null,
      });
      return true;
    } catch (failure) {
      const error = translateError(failure);
      set({ error });
      toast(error, "error");
      return false;
    } finally {
      set({ busy: false });
      if (changed || requested) {
        requested = true;
        // A mutation can finish before an earlier read. Never wait on it here.
        void load();
      }
    }
  };
  return {
    profiles: [],
    revision: null,
    selectedId: null,
    loading: false,
    busy: false,
    error: null,
    load,
    refresh: () => {
      if (!opened) return Promise.resolve();
      generation++;
      requested = true;
      return load();
    },
    save: (id, name, settings) => change(() => api.saveSettingsProfile(id, name, settings)),
    remove: (id) => change(() => api.deleteSettingsProfile(id)),
  };
});
