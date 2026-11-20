import type { WorkspaceTab } from "@/store/workspace";
import { useWorkspace } from "@/store/workspace";
import { useSettings } from "@/store/settings";
import { useEditors } from "@/store/editors";
import { useSsh } from "@/store/ssh";

/** Session identity, never host identity: connecting twice creates independent
 * sessions. History and host-detail panels are not live connection consumers. */
export function panelSessionIds(tab: WorkspaceTab): string[] {
  if (tab.kind === "terminal" || tab.kind === "monitor")
    return [tab.id.slice(tab.id.indexOf(":") + 1)];
  if (tab.kind === "editor") {
    const id = useEditors.getState().entries[tab.id]?.sessionId;
    return id ? [id] : [];
  }
  if (tab.kind !== "sftp") return [];
  return [
    ...new Set([
      ...(tab.fileSessionIds ?? []),
      ...(tab.fileSessionId ? [tab.fileSessionId] : []),
      ...(tab.filePane?.source.kind === "remote" ? [tab.filePane.source.sessionId] : []),
      ...(!tab.filePane && tab.id.startsWith("sftp:") ? [tab.id.slice(5).split(":copy:")[0]!] : []),
    ]),
  ];
}

/** Called only by explicit close actions, never by component unmount, tab
 * movement, layout restore, window handoff or server-initiated session removal.
 * Compute candidates before editor cleanup, then recheck all remaining panels. */
export function releaseClosedPanelSessions(candidates: readonly string[]) {
  if (!useSettings.getState().settings.disconnectOnPanelClose) return;
  const remaining = new Set(useWorkspace.getState().tabs.flatMap(panelSessionIds));
  for (const id of new Set(candidates)) {
    const session = useSsh.getState().sessions.find((item) => item.id === id);
    if (!session || remaining.has(id)) continue;
    // These connections are owned by persistent rules, not workspace panels.
    if (session.purpose === "forwarding" || session.purpose === "mounts") continue;
    void useSsh.getState().disconnect(id);
  }
}
