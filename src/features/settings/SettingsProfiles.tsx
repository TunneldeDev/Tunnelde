import { useMemo } from "react";
import { api, isTauri } from "@/lib/api/ipc";
import { portableSettings } from "@/lib/prefs/profiles";
import { useSettings } from "@/store/settings";
import { useSettingsProfiles } from "@/store/settingsProfiles";
import { useDialogs } from "@/store/dialogs";
import { toast } from "@/store/toasts";
import { useViewState, useBackgroundGuard } from "@/lib/session/viewState";
import {
  SettingsProfilesView,
  type SettingsProfilesServices,
} from "./components/SettingsProfilesView";
const services: SettingsProfilesServices = {
  useData() {
    const settings = useSettings((s) => s.settings);
    const snapshot = useMemo(() => portableSettings(settings), [settings]);
    const saving = useSettings((s) => s.saving);
    const { profiles, selectedId, revision, loading, busy, error } = useSettingsProfiles();
    const appDialogOpen = useDialogs((s) => s.dialog.kind !== "none");
    return {
      snapshot,
      saving,
      profiles,
      selectedId,
      revision,
      loading,
      busy,
      error,
      appDialogOpen,
      nativeAvailable: isTauri(),
    };
  },
  useViewState,
  useBusyGuard: useBackgroundGuard,
  readCurrent: () => ({
    saving: useSettings.getState().saving,
    busy: useSettingsProfiles.getState().busy,
    revision: useSettingsProfiles.getState().revision,
  }),
  load: () => useSettingsProfiles.getState().load(),
  refresh: () => useSettingsProfiles.getState().refresh(),
  save: (id, name, snapshot) => useSettingsProfiles.getState().save(id, name, snapshot),
  saveCurrent: (id, name) =>
    useSettingsProfiles
      .getState()
      .save(id, name, portableSettings(useSettings.getState().settings)),
  remove: (id) => useSettingsProfiles.getState().remove(id),
  apply: (request) => useSettings.getState().applyProfile(request),
  confirm: (options) => useDialogs.getState().confirm(options),
  importFile: () => api.importSettingsFile(),
  exportFile: (name, snapshot) => api.exportSettingsFile(name, snapshot),
  notify: toast,
};
export function SettingsProfiles(props: { hasDraft: boolean; onApplied(): void }) {
  return <SettingsProfilesView {...props} services={services} />;
}
