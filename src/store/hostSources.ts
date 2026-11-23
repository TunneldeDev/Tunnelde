import { reportError } from "@/lib/diagnostics";
import { diagnosticInvoke as invoke } from "@/lib/api/diagnosticInvoke";
import { nativeContributionSource, synchronizeContributions } from "@/lib/plugins/contributionSync";
import { sourceHosts, type HostSourcesSnapshot } from "@/lib/hosts/sources";
import { useHosts } from "./hosts";

export function wireHostSources(signal: AbortSignal): Promise<() => void> {
  return synchronizeContributions<HostSourcesSnapshot>(
    nativeContributionSource("plugin://host-sources-changed", {
      read: () => invoke("plugin_host_sources_snapshot"),
      apply: (snapshot) => useHosts.getState().setSourceHosts(sourceHosts(snapshot)),
      clear: () => useHosts.getState().setSourceHosts([]),
      report: (error) => reportError("plugins.hostSources", "synchronize", error),
    }),
    signal,
  );
}
