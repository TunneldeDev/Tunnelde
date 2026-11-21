import { create } from "zustand";
import { useWorkspace, type WorkspaceTab } from "@/store/workspace";
import { useSsh } from "@/store/ssh";
import { useSettings } from "@/store/settings";
import { useSearchRoots } from "@/store/searchRoots";
import type { FsSource, SshSession } from "@/lib/api/types";
import type { PanelWindowClient } from "@/lib/panels/windowClient";
import type { SftpPageProps } from "./SftpPage";
export const useFileWindowRegistrations = create<{
  entries: ReadonlyMap<string, { sources: FsSource[]; sessions: SshSession[]; encoded: string }>;
}>(() => ({ entries: new Map() }));
export function filePageProps(tab: WorkspaceTab): SftpPageProps {
  return {
    sessionId: tab.filePane?.ownerSessionId ?? tab.id.replace("sftp:", "").split(":copy:")[0]!,
    single: tab.filePane,
    scopeId: tab.filePane || tab.id.includes(":copy:") ? tab.id : undefined,
    tabId: tab.id,
  };
}
export function fileWindowTabs() {
  return useWorkspace
    .getState()
    .tabs.filter((tab) => tab.kind === "sftp" && !tab.filePane?.offline);
}
export function fileProviderAllowsMove() {
  return !useSettings.getState().settings.uiProviders.fileBrowser;
}
export async function bindFileWindow(client: PanelWindowClient, id: string) {
  const tab = fileWindowTabs().find((tab) => tab.id === id);
  if (!tab) throw new Error("panel.window.staleOwner");
  const sessions = useSsh
    .getState()
    .sessions.filter((s) => !s.purpose)
    .slice(0, 64);
  const sources: FsSource[] = [
    { kind: "local" },
    ...sessions.map((s) => ({ kind: "remote" as const, sessionId: s.id })),
  ];
  const encoded = JSON.stringify([sources, fileProviderAllowsMove()]);
  const lease = await client.files.bind(id, sources, fileProviderAllowsMove());
  useFileWindowRegistrations.setState((state) => {
    const entries = new Map(state.entries);
    entries.set(id, { sources, sessions, encoded });
    return { entries };
  });
  return lease;
}
export async function synchronizeFileWindows(client: PanelWindowClient) {
  const tabs = new Set(fileWindowTabs().map((tab) => tab.id));
  for (const [id, value] of useFileWindowRegistrations.getState().entries) {
    if (!tabs.has(id)) {
      useFileWindowRegistrations.setState((state) => {
        const entries = new Map(state.entries);
        entries.delete(id);
        return { entries };
      });
      useSearchRoots.getState().remove(`native-files:${id}`);
      continue;
    }
    const sessions = useSsh
      .getState()
      .sessions.filter((s) => !s.purpose)
      .slice(0, 64);
    const sources: FsSource[] = [
      { kind: "local" },
      ...sessions.map((s) => ({ kind: "remote" as const, sessionId: s.id })),
    ];
    if (JSON.stringify([sources, fileProviderAllowsMove()]) === value.encoded) continue;
    try {
      await bindFileWindow(client, id);
    } catch (error) {
      // Existing native/relay effects own the old source set until settlement.
      // Their final changed notification retries this synchronization.
      if (
        !String((error as { message?: unknown })?.message ?? error).includes(
          "panel interaction in progress",
        )
      )
        throw error;
    }
  }
}
