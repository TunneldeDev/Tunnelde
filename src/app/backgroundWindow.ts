import {
  decodeTerminalCheckpoint,
  encodeTerminalCheckpoint,
  type TerminalCheckpointWire,
} from "@/features/terminal/terminalCheckpointCodec";
import { isFloatingRect } from "@/lib/layout/floatingPanel";
import { useEffect } from "react";
import { api, events, isTauri } from "@/lib/api/ipc";
import { flushEditorDrafts } from "@/lib/editor/recovery/persistence";
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
import { useEditors, editorHistorySnapshot, restoreEditorHistory } from "@/store/editors";
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
import { usePanelPresentations, panelPresentation } from "@/store/panelPresentation";
import { sidebarViewOf } from "@/lib/session/sidebarDock";
import { useRestartPrompt } from "@/store/restartPrompt";
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
  version: 1 | 2;
  workspace: ReturnType<typeof captureWorkspace>;
  navigation: ReturnType<typeof captureNavigation>;
  editors: ReturnType<typeof useEditors.getState>["entries"];
  editorHistory?: ReturnType<typeof editorHistorySnapshot>;
  sessions: ReturnType<typeof useSsh.getState>["sessions"];
  sessionHistory?: ReturnType<typeof useSsh.getState>["history"];
  outputs: ReturnType<typeof usePlugins.getState>["outputs"];
  storageDraft: ReturnType<typeof useStorage.getState>["draft"];
  restartPrompt?: Pick<ReturnType<typeof useRestartPrompt.getState>, "observed">;
  monitorHistory: ReturnType<typeof useMonitorHistory.getState>["samples"];
  clipboard: ReturnType<typeof useFileClipboard.getState>["clip"];
  views: Record<string, unknown>;
  terminals: Record<string, TerminalCheckpoint | TerminalCheckpointWire>;
  transferPanel?: Pick<ReturnType<typeof useTransferPanel.getState>, "open" | "pinned" | "bounds">;
  panelPresentations?: Record<
    string,
    Pick<ReturnType<typeof useTransferPanel.getState>, "open" | "pinned" | "bounds">
  >;
  backgroundTaskHistory?: ReturnType<typeof backgroundTaskHistory>;
}

/** Resume only the still-running native process; this data is never written to disk. */
export async function restoreBackgroundSnapshot(): Promise<boolean> {
  const text = await api.mainWindowSnapshot();
  if (!text) return false;
  const snapshot = decodeViewSnapshot<WindowSnapshot>(text);
  if (
    ![1, 2].includes(snapshot.version) ||
    !Array.isArray(snapshot.workspace?.tabs) ||
    !snapshot.editors ||
    !snapshot.terminals
  ) {
    throw new Error("window.invalidSnapshot");
  }
  // Validate the complete new terminal batch before restoring any main store.
  const terminals =
    snapshot.version === 2
      ? Object.fromEntries(
          Object.entries(snapshot.terminals).map(([id, value]) => [
            id,
            decodeTerminalCheckpoint(value, "background"),
          ]),
        )
      : (snapshot.terminals as Record<string, TerminalCheckpoint>);
  restoreViewState(snapshot.views);
  restoreTerminalCheckpoints(terminals);
  useEditors.setState({ entries: snapshot.editors });
  restoreEditorHistory(snapshot.editorHistory);
  useSsh.setState({ sessions: snapshot.sessions, history: snapshot.sessionHistory ?? [] });
  usePlugins.setState({ outputs: snapshot.outputs });
  useStorage.setState({ draft: snapshot.storageDraft });
  useRestartPrompt.setState({ observed: snapshot.restartPrompt?.observed ?? null, open: false });
  useMonitorHistory.setState({ samples: snapshot.monitorHistory });
  useFileClipboard.setState({ clip: snapshot.clipboard });
  useWorkspace.setState(snapshot.workspace);
  useNavigation.setState(snapshot.navigation);
  if (snapshot.transferPanel) useTransferPanel.setState(snapshot.transferPanel);
  if (snapshot.panelPresentations)
    for (const [id, state] of Object.entries(snapshot.panelPresentations)) {
      const view = sidebarViewOf(`sidebar:${id}`);
      if (
        view &&
        state &&
        typeof state === "object" &&
        typeof state.open === "boolean" &&
        typeof state.pinned === "boolean" &&
        (state.bounds === null || isFloatingRect(state.bounds))
      )
        panelPresentation(view).setState({
          open: state.open,
          pinned: state.pinned,
          bounds: state.bounds,
        });
    }
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
    await flushEditorDrafts();
    if (cancellation !== revision || busy()) return;
    const snapshot: WindowSnapshot = {
      version: 2,
      panelPresentations: Object.fromEntries(
        Object.entries(usePanelPresentations.getState().panels).map(([id, state]) => [
          id,
          { open: !!state?.open, pinned: !!state?.pinned, bounds: state?.bounds ?? null },
        ]),
      ),
      backgroundTaskHistory: backgroundTaskHistory(),
      transferPanel: {
        open: useTransferPanel.getState().open,
        pinned: useTransferPanel.getState().pinned,
        bounds: useTransferPanel.getState().bounds,
      },
      workspace: captureWorkspace(),
      navigation: captureNavigation(),
      editors: useEditors.getState().entries,
      editorHistory: editorHistorySnapshot(),
      sessions,
      sessionHistory: useSsh.getState().history,
      terminals: Object.fromEntries(
        Object.entries(terminals).map(([id, value]) => [
          id,
          encodeTerminalCheckpoint(value, "background"),
        ]),
      ),
      outputs: usePlugins.getState().outputs,
      storageDraft: useStorage.getState().draft,
      restartPrompt: { observed: useRestartPrompt.getState().observed },
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
