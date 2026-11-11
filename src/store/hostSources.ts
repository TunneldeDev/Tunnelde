import { invoke } from "@tauri-apps/api/core";
import { nativeContributionSource, synchronizeContributions } from "@/lib/plugins/contributionSync";
import { sourceHosts, type HostSourcesSnapshot } from "@/lib/hosts/sources";
import { useHosts } from "./hosts";

export function wireHostSources(signal: AbortSignal): Promise<() => void> {
  return synchronizeContributions<HostSourcesSnapshot>(
    nativeContributionSource("plugin://host-sources-changed", {
      read: () => invoke("plugin_host_sources_snapshot"),
      apply: (snapshot) => useHosts.getState().setSourceHosts(sourceHosts(snapshot)),
      clear: () => useHosts.getState().setSourceHosts([]),
      report: (error) => console.error("Could not synchronize host sources", error),
    }),
    signal,
  );
}
