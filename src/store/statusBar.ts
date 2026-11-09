import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { synchronizeContributions, nativeContributionSource } from "@/lib/plugins/contributionSync";
import type { StatusBarSnapshot } from "@/lib/plugins/statusBar";

export const useStatusBarContributions = create<StatusBarSnapshot>(() => ({
  revision: -1,
  items: [],
}));

/** Shared subscription protocol keeps authorization changes and WebView reloads consistent. */
export function wireStatusBarContributions(signal: AbortSignal): Promise<() => void> {
  return synchronizeContributions<StatusBarSnapshot>(
    nativeContributionSource("plugin://status-bar-changed", {
      read: () => invoke("plugin_status_bar_snapshot"),
      apply: (snapshot) => useStatusBarContributions.setState(snapshot),
      clear: () => useStatusBarContributions.setState({ items: [] }),
      report: (error) => console.error("Could not synchronize status bar contributions", error),
    }),
    signal,
  );
}
