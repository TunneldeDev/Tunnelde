import { useStorage } from "@/store/storage";
import { useRestartPrompt } from "@/store/restartPrompt";

/** Recover missed invalidations without scanning storage unless Settings requested it. */
export async function reconcileStorageMetadata(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  const state = useStorage.getState();
  const inventoryRequested = state.status !== null || state.loading;
  await state.refreshMetadata(signal);
  if (signal.aborted) return;
  if (useStorage.getState().restartPending) useRestartPrompt.getState().show();
  else useRestartPrompt.getState().close();
  if (!inventoryRequested) return;

  // An initial inventory may still be running with a pre-invalidation revision.
  // Join that read before starting a fresh one, including when status is still null.
  const alreadyLoading = useStorage.getState().loading;
  await useStorage.getState().load();
  if (alreadyLoading && !signal.aborted) await useStorage.getState().load();
}
