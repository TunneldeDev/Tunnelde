import { api } from "@/lib/api/ipc";
import { useSettings } from "@/store/settings";

export function notifyHistoryChanged(hostId: string) {
  window.dispatchEvent(new CustomEvent("tunnelde:history-changed", { detail: { hostId } }));
}

/** Notify mounted history panels only after the new entry is persisted. */
export async function recordTerminalCommand(hostId: string, command: string): Promise<void> {
  if (!useSettings.getState().settings.recordTerminalHistory || command.startsWith(" ")) return;
  const entry = await api.historyRecord(hostId, command);
  if (entry) notifyHistoryChanged(hostId);
}
