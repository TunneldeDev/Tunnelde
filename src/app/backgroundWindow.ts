import { useEffect } from "react";
import { api, events, isTauri } from "@/lib/api/ipc";
import {
  prepareTerminalCheckpoints,
  resumeTerminalCheckpoints,
  restoreTerminalCheckpoints,
  type TerminalCheckpoint,
} from "@/features/terminal/terminalCheckpoint";
import {
  decodeViewSnapshot,
  encodeViewSnapshot,
  restoreViewState,
  viewIsBusy,
  viewStateSnapshot,
} from "@/lib/session/viewState";
import { useWorkspace } from "@/store/workspace";
import { useEditors } from "@/store/editors";
import { useNavigation } from "@/store/navigation";
import { useSsh } from "@/store/ssh";
import { useSettings } from "@/store/settings";
import { usePlugins } from "@/store/plugins";
import { usePluginSecurity } from "@/store/pluginSecurity";
import { useStorage } from "@/store/storage";
import { useDialogs } from "@/store/dialogs";
import { useMonitorHistory } from "@/store/monitorHistory";
import { useFileClipboard } from "@/store/fileClipboard";
import { useMarketplace } from "@/store/marketplace";
import { useSettingsProfiles } from "@/store/settingsProfiles";
import { useTransferPanel } from "@/store/transferPanel";
import {
  backgroundTasksBlockSuspension,
  backgroundTaskHistory,
  restoreBackgroundTaskHistory,
} from "@/lib/tasks/background";

function captureWorkspace() {
  const { tabs, panes, activePaneId, activeId, split, layout } = useWorkspace.getState();
  return { tabs, panes, activePaneId, activeId, split, layout };
}

function captureNavigation() {
  const { activeSidebar, sidebarVisible, visitedSidebars, settingsSection } =
    useNavigation.getState();
  return { activeSidebar, sidebarVisible, visitedSidebars, settingsSection };
}

interface WindowSnapshot {
  version: 1;
  workspace: ReturnType<typeof captureWorkspace>;
  navigation: ReturnType<typeof captureNavigation>;
  editors: ReturnType<typeof useEditors.getState>["entries"];
  sessions: ReturnType<typeof useSsh.getState>["sessions"];
  outputs: ReturnType<typeof usePlugins.getState>["outputs"];
  storageDraft: ReturnType<typeof useStorage.getState>["draft"];
  monitorHistory: ReturnType<typeof useMonitorHistory.getState>["samples"];
  clipboard: ReturnType<typeof useFileClipboard.getState>["clip"];
  views: Record<string, unknown>;
  terminals: Record<string, TerminalCheckpoint>;
  transferPanel?: Pick<ReturnType<typeof useTransferPanel.getState>, "open" | "pinned" | "bounds">;
  backgroundTaskHistory?: ReturnType<typeof backgroundTaskHistory>;
}

/** Resume only the still-running native process; this data is never written to disk. */
export async function restoreBackgroundSnapshot(): Promise<boolean> {
  const text = await api.mainWindowSnapshot();
  if (!text) return false;
  const snapshot = decodeViewSnapshot<WindowSnapshot>(text);
  if (
    snapshot.version !== 1 ||
    !Array.isArray(snapshot.workspace?.tabs) ||
    !snapshot.editors ||
    !snapshot.terminals
  ) {
    throw new Error("window.invalidSnapshot");
  }
  restoreViewState(snapshot.views);
  restoreTerminalCheckpoints(snapshot.terminals);
  useEditors.setState({ entries: snapshot.editors });
  useSsh.setState({ sessions: snapshot.sessions });
  usePlugins.setState({ outputs: snapshot.outputs });
  useStorage.setState({ draft: snapshot.storageDraft });
  useMonitorHistory.setState({ samples: snapshot.monitorHistory });
  useFileClipboard.setState({ clip: snapshot.clipboard });
  useWorkspace.setState(snapshot.workspace);
  useNavigation.setState(snapshot.navigation);
  if (snapshot.transferPanel) useTransferPanel.setState(snapshot.transferPanel);
  if (snapshot.backgroundTaskHistory) restoreBackgroundTaskHistory(snapshot.backgroundTaskHistory);
  return true;
}

function busy() {
  const ssh = useSsh.getState();
  const security = usePluginSecurity.getState();
  return (
    viewIsBusy() ||
    backgroundTasksBlockSuspension() ||
    document.querySelector('[role="dialog"]:not([aria-modal="false"])') !== null ||
    useDialogs.getState().dialog.kind !== "none" ||
    Object.values(useEditors.getState().entries).some((entry) => entry.loading || entry.saving) ||
    ssh.connectingHostIds.length > 0 ||
    ssh.disconnectingSessionIds.length > 0 ||
    useSettings.getState().saving ||
    usePlugins.getState().busyIds.length > 0 ||
    usePlugins.getState().reloading ||
    security.busy ||
    security.prompts.length > 0 ||
    useStorage.getState().busy ||
    useSettingsProfiles.getState().busy ||
    Object.values(useMarketplace.getState().tasks).some(
      (task) => !["done", "failed", "cancelled"].includes(task.phase),
    )
  );
}

let active = false;
let cancellation = 0;

export async function suspendBackgroundWindow(token: number): Promise<void> {
  if (active) return;
  if (busy()) {
    await api.mainWindowSuspend(token, null);
    return;
  }
  active = true;
  const revision = cancellation;
  let suspended = false;
  try {
    const sessions = useSsh.getState().sessions;
    const terminalIds = useWorkspace
      .getState()
      .tabs.filter((tab) => tab.kind === "terminal")
      .map((tab) => tab.id.replace("terminal:", ""));
    const terminals = await prepareTerminalCheckpoints(terminalIds);
    if (cancellation !== revision || busy()) return;
    const snapshot: WindowSnapshot = {
      version: 1,
      backgroundTaskHistory: backgroundTaskHistory(),
      transferPanel: {
        open: useTransferPanel.getState().open,
        pinned: useTransferPanel.getState().pinned,
        bounds: useTransferPanel.getState().bounds,
      },
      workspace: captureWorkspace(),
      navigation: captureNavigation(),
      editors: useEditors.getState().entries,
      sessions,
      terminals,
      outputs: usePlugins.getState().outputs,
      storageDraft: useStorage.getState().draft,
      monitorHistory: useMonitorHistory.getState().samples,
      clipboard: useFileClipboard.getState().clip,
      views: viewStateSnapshot(),
    };
    suspended = await api.mainWindowSuspend(token, encodeViewSnapshot(snapshot));
  } catch (error) {
    console.warn("Background window checkpoint deferred", error);
  } finally {
    if (!suspended) {
      await resumeTerminalCheckpoints();
      await api.mainWindowSuspend(token, null).catch(() => undefined);
    }
    active = false;
  }
}

export function useBackgroundWindow() {
  useEffect(() => {
    if (!isTauri()) return;
    const lifetime = new AbortController();
    void events
      .onWindowSuspend((token) => void suspendBackgroundWindow(token), lifetime.signal)
      .catch((error) => console.warn("Could not register background checkpoint listener", error));
    void events
      .onWindowResume(() => {
        cancellation++;
        if (!active) void resumeTerminalCheckpoints();
      }, lifetime.signal)
      .catch((error) => console.warn("Could not register background resume listener", error));
    return () => {
      cancellation++;
      lifetime.abort();
    };
  }, []);
}
