import type { Settings, UpdateState } from "@/lib/api/types";

export function updateHistoryKey(state: UpdateState): string {
  return JSON.stringify([
    state.currentVersion,
    state.version,
    state.channel,
    state.source,
    state.sourceUrl,
    state.lastChecked,
  ]);
}

export function matchingUpdateState(
  state: UpdateState | null,
  settings: Settings,
): UpdateState | null {
  return state?.channel === settings.updateChannel &&
    state.source === settings.updateSource &&
    state.sourceUrl === settings.updateSourceUrl
    ? state
    : null;
}
