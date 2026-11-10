import type { Host } from "@/lib/api/types";
import { useHosts } from "@/store/hosts";
import { useDialogs } from "@/store/dialogs";
import { useWorkspace, type WorkspaceTab } from "@/store/workspace";
import { usePlugins } from "@/store/plugins";
import { useSsh } from "@/store/ssh";
import { useEditorLocation } from "@/store/editorLocation";
import { useFilePreview } from "@/store/filePreview";
import { matchesPreview, previewKind, previewProviders } from "@/lib/files/preview";
import type { Match } from "../data/model";
export function openQuickAccessHost(host: Host, connect: boolean) {
  if (useHosts.getState().hosts.find((item) => item.id === host.id) !== host)
    throw new Error("plugin.quickAccess.changed");
  if (connect) useDialogs.getState().openConnect(host);
  else useWorkspace.getState().openHost(host);
}
export function openQuickAccessTab(tab: WorkspaceTab) {
  if (!useWorkspace.getState().tabs.includes(tab)) throw new Error("plugin.quickAccess.changed");
  useWorkspace.getState().activate(tab.id);
}
export function openQuickAccessMatch(match: Match, sessionId: string | null) {
  if (sessionId && !useSsh.getState().sessions.some((session) => session.id === sessionId))
    throw new Error("pluginChat.targetDisconnected");
  const provider = previewProviders(usePlugins.getState().items).find((item) =>
    matchesPreview(item, match.path),
  );
  if ((provider?.renderer ?? previewKind(match.path)) !== "text") {
    useFilePreview
      .getState()
      .show(
        match.path,
        match.line,
        match.column,
        sessionId ? { kind: "remote", sessionId } : { kind: "local" },
      );
    return;
  }
  if (!sessionId) {
    useWorkspace.getState().openLocalEditor(match.path);
    if (match.line)
      useEditorLocation.getState().reveal(`editor-local:${match.path}`, match.line, match.column);
    return;
  }
  const session = useSsh.getState().sessions.find((item) => item.id === sessionId);
  if (!session) {
    throw new Error("pluginChat.targetDisconnected");
  }
  useWorkspace.getState().openEditor(session, match.path);
  if (match.line)
    useEditorLocation
      .getState()
      .reveal(`editor:${session.id}:${match.path}`, match.line, match.column);
}
