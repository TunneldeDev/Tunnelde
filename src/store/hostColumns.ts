import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { synchronizeContributions, nativeContributionSource } from "@/lib/plugins/contributionSync";
import {
  indexHostColumns,
  type DisplayHostColumn,
  type HostColumnsSnapshot,
} from "@/lib/hosts/columns";
export const useHostColumns = create<{ revision: number; columns: DisplayHostColumn[] }>(() => ({
  revision: -1,
  columns: [],
}));
export function wireHostColumns(signal: AbortSignal): Promise<() => void> {
  return synchronizeContributions<HostColumnsSnapshot>(
    nativeContributionSource("plugin://host-columns-changed", {
      read: () => invoke("plugin_host_columns_snapshot"),
      apply: (snapshot) =>
        useHostColumns.setState({
          revision: snapshot.revision,
          columns: indexHostColumns(snapshot.items),
        }),
      clear: () => useHostColumns.setState({ columns: [] }),
      report: (error) => console.error("Could not synchronize host columns", error),
    }),
    signal,
  );
}
