import { reportError } from "@/lib/diagnostics";
import { diagnosticInvoke as invoke } from "@/lib/api/diagnosticInvoke";
import { create } from "zustand";
import { nativeContributionSource, synchronizeContributions } from "@/lib/plugins/contributionSync";
import {
  indexFileHighlights,
  type FileHighlightSnapshot,
  type OwnedFileHighlight,
} from "@/lib/plugins/fileHighlights";

export const useFileHighlights = create<{
  revision: number;
  bySource: ReadonlyMap<string, OwnedFileHighlight[]>;
}>(() => ({ revision: -1, bySource: new Map() }));

export function wireFileHighlights(signal: AbortSignal): Promise<() => void> {
  return synchronizeContributions<FileHighlightSnapshot>(
    nativeContributionSource("plugin://file-highlights-changed", {
      read: () => invoke("plugin_file_highlights_snapshot"),
      apply: (snapshot) =>
        useFileHighlights.setState({
          revision: snapshot.revision,
          bySource: indexFileHighlights(snapshot.items),
        }),
      clear: () => useFileHighlights.setState({ bySource: new Map() }),
      report: (error) => reportError("plugins.fileHighlights", "synchronize", error),
    }),
    signal,
  );
}
