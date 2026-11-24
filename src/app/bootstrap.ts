import { startHabits, restoreWorkspaceHabits, useHabits } from "@/store/habits";
import { api, events, isTauri } from "@/lib/api/ipc";
import type { TabRecord } from "@/lib/api/types";
import { observeSystemAppearance } from "@/lib/prefs/appearance";
import i18n from "@/i18n/i18n";
import { presentError } from "@/lib/api/errors";
import { toast } from "@/store/toasts";
import { useHosts } from "@/store/hosts";
import { useSsh } from "@/store/ssh";
import { useMonitor } from "@/store/monitor";
import { usePlugins } from "@/store/plugins";
import { reportPluginExecutionFailure, usePluginSecurity } from "@/store/pluginSecurity";
import { useTransfers } from "@/store/transfers";
import { useEditorCleanup } from "@/store/editorCleanup";
import { useSettings } from "@/store/settings";
import { useSettingsProfiles } from "@/store/settingsProfiles";
import { useUpdates } from "@/store/updates";
import { useWorkspace, workspaceRecords } from "@/store/workspace";
import { createEventLifecycle, type Subscription } from "@/lib/events/lifecycle";
import type { Dispose } from "@/lib/events/bus";
import { reconcilePluginWorkspace, wirePluginWorkspaceBridge } from "./pluginWorkspaceBridge";
import { restoreBackgroundSnapshot } from "./backgroundWindow";
import { registerBackgroundTaskSources } from "./backgroundTaskSources";
import { frontendRuntime } from "@/lib/extensions/frontendRuntime";
import { createPluginActivationBridge } from "./plugins/activationBridge";
import { reportError } from "@/lib/diagnostics";
import { startPanelWindows } from "./panelWindows";
import { startDraftRecovery } from "@/lib/editor/recovery/persistence";

let startup: Promise<void> | undefined;
let persistTimer: number | undefined;
let pendingRecords: TabRecord[] | undefined;
let saving = false;
let lifetime: AbortController | undefined;
const cleanups: Dispose[] = [];

export function bootstrap(): Promise<void> {
  if (startup) return startup;
  const controller = new AbortController();
  lifetime = controller;
  const task = start(controller.signal).catch((error) => {
    if (lifetime === controller) disposeBootstrap();
    throw error;
  });
  startup = task;
  return task;
}

/** Release view-owned resources; native SSH sessions and transfers keep running. */
export function disposeBootstrap(): void {
  lifetime?.abort();
  lifetime = undefined;
  startup = undefined;
  if (persistTimer !== undefined) pendingRecords = workspaceRecords();
  window.clearTimeout(persistTimer);
  persistTimer = undefined;
  for (const stop of cleanups.splice(0).reverse()) {
    try {
      stop();
    } catch (error) {
      reportError("startup", "releaseViewResource", error);
    }
  }
  if (pendingRecords) void persistLatest();
}

if (import.meta.hot) import.meta.hot.dispose(disposeBootstrap);

async function start(signal: AbortSignal): Promise<void> {
  cleanups.push(registerBackgroundTaskSources());
  const initialTabs = useWorkspace.getState().tabs;
  window.addEventListener("contextmenu", (event) => event.preventDefault(), { signal });

  if (isTauri()) {
    cleanups.push(() => frontendRuntime.dispose());
    cleanups.push(
      usePlugins.subscribe((state) => {
        frontendRuntime.reconcile(state.items, false);
        for (const id of state.stoppingIds) frontendRuntime.stop(id);
      }),
    );
    await wireEvents();
  }
  if (signal.aborted) return;

  await useSettings.getState().load();
  if (signal.aborted) return;
  cleanups.push(observeSystemAppearance(() => useSettings.getState().settings));
  const restoreWorkspace = useSettings.getState().settings.restoreWorkspace !== false;

  if (!isTauri()) {
    useWorkspace.getState().ensureWelcome();
    return;
  }

  cleanups.push(await startHabits());
  if (signal.aborted) return;

  // Discover view contributions before restoring their tabs; discovery does not execute plugins.
  await Promise.all([usePluginSecurity.getState().load(), usePlugins.getState().load()]);
  if (signal.aborted) return;
  let restored = false;
  let resumed = false;
  try {
    resumed = await restoreBackgroundSnapshot();
    const records = resumed ? [] : await api.tabs();
    if (signal.aborted) return;
    // A slow snapshot must not replace tabs opened while startup is in progress.
    if (resumed || restoreWorkspace) {
      if (!resumed && useWorkspace.getState().tabs === initialTabs)
        useWorkspace.getState().hydrate(records);
      restored = true;
    }
  } catch (error) {
    if (signal.aborted) return;
    toast(presentError(error), "error");
  }
  cleanups.push(restoreWorkspaceHabits());
  const hostsLoaded = await useHosts.getState().load();
  if (signal.aborted) return;
  if (hostsLoaded) pruneMissingHosts();
  try {
    cleanups.push(await startDraftRecovery(signal, resumed));
  } catch (error) {
    if (!signal.aborted) toast(presentError(error), "error");
  }
  if (signal.aborted) return;
  await useSsh.getState().refresh();
  if (signal.aborted) return;
  // The global background task list must work before any file page is opened.
  void useTransfers.getState().hydrate();
  void useEditorCleanup
    .getState()
    .hydrate()
    .catch((error) => toast(presentError(error), "error"));
  useWorkspace.getState().ensureWelcome();

  cleanups.push(
    useWorkspace.subscribe((state, previous) => {
      if (
        state.tabs === previous.tabs &&
        state.panes === previous.panes &&
        state.layout === previous.layout &&
        state.activePaneId === previous.activePaneId
      )
        return;
      schedulePersistence();
    }),
  );
  // Save pruned/normalized restoration, but never overwrite an unreadable snapshot.
  if (restored) schedulePersistence();
  try {
    cleanups.push(await startPanelWindows(signal));
  } catch (error) {
    if (!signal.aborted) reportError("panels.windows", "startup", error);
  }
  void useUpdates.getState().refresh();
}

function schedulePersistence(): void {
  window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
    persistTimer = undefined;
    pendingRecords = workspaceRecords();
    void persistLatest();
  }, 400);
}

async function persistLatest(): Promise<void> {
  if (saving) return;
  saving = true;
  try {
    while (pendingRecords) {
      const records = pendingRecords;
      pendingRecords = undefined;
      try {
        if (!useHabits.getState().workspaceCleared) await api.saveTabs(records);
      } catch (error) {
        toast(presentError(error), "error");
      }
    }
  } finally {
    saving = false;
  }
}

function pruneMissingHosts(): void {
  const known = new Set(useHosts.getState().hosts.map((host) => host.id));
  for (const tab of useWorkspace.getState().tabs) {
    if (tab.kind === "host" && tab.hostId && !known.has(tab.hostId)) {
      useWorkspace.getState().close(tab.id);
    }
  }
}

async function wireEvents(): Promise<void> {
  const activation = createPluginActivationBridge({
    subscribe: (handler, signal) => events.onPluginActivation(handler, signal),
    read: () => usePlugins.getState(),
    load: (request) => usePlugins.getState().refreshActivation(request),
    ensure: (plugin) => frontendRuntime.ensure(plugin),
    report: (error) => reportError("plugins.activation", "frontend-request", error),
  });
  cleanups.push(() => activation.dispose());
  const subscriptions: Subscription[] = [
    activation.subscription,
    {
      register: (signal) => wirePluginWorkspaceBridge(signal),
      recover: reconcilePluginWorkspace,
    },
    {
      register: (signal) =>
        events.onSettingsChanged((settings) => {
          useSettings.getState().applyRemote(settings);
        }, signal),
      recover: () => useSettings.getState().load(),
    },
    {
      register: (signal) =>
        events.onSettingsProfilesChanged(() => {
          void useSettingsProfiles.getState().refresh();
        }, signal),
      recover: () => useSettingsProfiles.getState().refresh(),
    },
    {
      register: (signal) =>
        events.onUpdateState((state) => useUpdates.getState().apply(state), signal),
      recover: () => useUpdates.getState().refresh(),
    },
    {
      register: (signal) =>
        events.onNavigate((page) => {
          if (
            page === "welcome" ||
            page === "settings" ||
            page === "about" ||
            page === "updates" ||
            page === "knownHosts"
          ) {
            useWorkspace.getState().openPage(page);
          }
        }, signal),
    },
    {
      register: (signal) =>
        events.onPluginState((payload) => {
          if (payload.status !== "running") frontendRuntime.stop(payload.id);
          usePlugins.getState().apply(payload);
          if (payload.status === "failed" && payload.error)
            reportPluginExecutionFailure({ code: "validation", message: payload.error });
        }, signal),
      recover: () => usePlugins.getState().load(),
    },
    {
      register: (signal) =>
        events.onPluginSecurity((payload) => {
          frontendRuntime.reconcileSecurity(payload);
          usePluginSecurity.getState().apply(payload);
        }, signal),
      recover: () => usePluginSecurity.getState().load(true),
    },
    {
      register: (signal) =>
        events.onEditorCleanupChanged(() => {
          void useEditorCleanup
            .getState()
            .hydrate()
            .catch((error) => toast(presentError(error), "error"));
        }, signal),
      recover: () => useEditorCleanup.getState().hydrate(),
    },
    {
      register: (signal) =>
        events.onTransfer((payload) => useTransfers.getState().apply(payload), signal),
      recover: () => useTransfers.getState().hydrate(),
    },
    {
      register: (signal) =>
        events.onTransfersChanged(() => {
          void useTransfers.getState().hydrate();
        }, signal),
    },
    {
      register: (signal) =>
        events.onSshClosed((payload) => {
          const session = useSsh
            .getState()
            .sessions.find((session) => session.id === payload.sessionId);
          useSsh.getState().forget(payload.sessionId, payload.reason);
          useMonitor.getState().forget(payload.sessionId);
          useWorkspace.getState().closeSession(payload.sessionId);
          if (session && session.terminal !== false) toast(i18n.t("ssh.sessionEnded"), "info");
        }, signal),
      recover: () => useSsh.getState().refresh(),
    },
  ];
  const listeners = createEventLifecycle(subscriptions, (error) =>
    toast(presentError(error), "error"),
  );
  cleanups.push(() => listeners.dispose());
  await listeners.start();
}
