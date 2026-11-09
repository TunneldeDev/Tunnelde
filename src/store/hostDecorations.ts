import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { synchronizeContributions, nativeContributionSource } from "@/lib/plugins/contributionSync";
import {
  indexHostDecorations,
  type HostDecorationSnapshot,
  type OwnedHostDecoration,
} from "@/lib/plugins/hostList";

export const useHostDecorations = create<{
  revision: number;
  byHost: ReadonlyMap<string, OwnedHostDecoration[]>;
}>(() => ({ revision: -1, byHost: new Map() }));

export function wireHostDecorations(signal: AbortSignal): Promise<() => void> {
  return synchronizeContributions<HostDecorationSnapshot>(
    nativeContributionSource("plugin://host-list-changed", {
      read: () => invoke("plugin_host_list_snapshot"),
      apply: (snapshot) =>
        useHostDecorations.setState({
          revision: snapshot.revision,
          byHost: indexHostDecorations(snapshot.items),
        }),
      clear: () => useHostDecorations.setState({ byHost: new Map() }),
      report: (error) => console.error("Could not synchronize host decorations", error),
    }),
    signal,
  );
}
