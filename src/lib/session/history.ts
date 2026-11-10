import { domainEvents } from "@/lib/events/domain";
import { api } from "@/lib/api/ipc";
import { useSettings } from "@/store/settings";

export function notifyHistoryChanged(hostId: string) {
  // Native and plugin mutations share the committed domain event. Browser-only
  // integrations retain the existing local notification without duplicating IPC refreshes.
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) return;
  domainEvents.historyChanged(hostId);
}

/** Notify mounted history panels only after the new entry is persisted. */
export async function recordTerminalCommand(hostId: string, command: string): Promise<void> {
  if (!useSettings.getState().settings.recordTerminalHistory || command.startsWith(" ")) return;
  const entry = await api.historyRecord(hostId, command);
  if (entry) notifyHistoryChanged(hostId);
}
