import { reportError } from "@/lib/diagnostics";
import { diagnosticInvoke as invoke } from "@/lib/api/diagnosticInvoke";
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
      report: (error) => reportError("plugins.statusBar", "synchronize", error),
    }),
    signal,
  );
}
