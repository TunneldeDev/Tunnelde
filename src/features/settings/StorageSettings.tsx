import { api, isTauri } from "@/lib/api/ipc";
import { useRestartPrompt } from "@/store/restartPrompt";
import { useStorage } from "@/store/storage";
import { toast } from "@/store/toasts";
import { useViewState, useBackgroundGuard } from "@/lib/session/viewState";
import {
  StorageSettingsView,
  type StorageSettingsServices,
} from "./components/StorageSettingsView";
import { changeStorageDraft } from "./data/storageDraft";

const services: StorageSettingsServices = {
  useData() {
    const { status, loading, busy, error, draft } = useStorage();
    return { status, loading, busy, error, draft, nativeAvailable: isTauri() };
  },
  useViewState,
  useBusyGuard: useBackgroundGuard,
  load: () => useStorage.getState().load(),
  changeDraft: (change) =>
    useStorage.getState().setDraft((current) => changeStorageDraft(current, change)),
  schedule: (changes) => useStorage.getState().schedule(changes),
  cancel: () => useStorage.getState().cancel(),
  pick: () => api.storagePick(),
  open: (category) => api.storageOpen(category),
  reviewRestart: () => useRestartPrompt.getState().show(),
  notify: toast,
};
export function StorageSettings() {
  return <StorageSettingsView services={services} />;
}
