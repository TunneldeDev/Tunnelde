import { api, events, isTauri } from "@/lib/api/ipc";
import type { TabRecord } from "@/lib/api/types";
import { observeSystemAppearance } from "@/lib/prefs/appearance";
import i18n from "@/i18n/i18n";
import { translateError } from "@/lib/api/errors";
import { toast } from "@/store/toasts";
import { useHosts } from "@/store/hosts";
import { useSsh } from "@/store/ssh";
import { useMonitor } from "@/store/monitor";
import { usePlugins } from "@/store/plugins";
import { reportPluginExecutionFailure, usePluginSecurity } from "@/store/pluginSecurity";
import { useTransfers } from "@/store/transfers";
import { useSettings } from "@/store/settings";
import { useUpdates } from "@/store/updates";
import { useWorkspace, workspaceRecords } from "@/store/workspace";
import { createEventLifecycle, type Subscription } from "@/lib/events/lifecycle";
import type { Dispose } from "@/lib/events/bus";
import { reconcilePluginWorkspace, wirePluginWorkspaceBridge } from "./pluginWorkspaceBridge";

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
      console.error("Failed to release a view resource", error);
    }
  }
  if (pendingRecords) void persistLatest();
}

if (import.meta.hot) import.meta.hot.dispose(disposeBootstrap);

async function start(signal: AbortSignal): Promise<void> {
  const initialTabs = useWorkspace.getState().tabs;
  window.addEventListener("contextmenu", (event) => event.preventDefault(), { signal });

  if (isTauri()) await wireEvents();
  if (signal.aborted) return;

  await useSettings.getState().load();
  if (signal.aborted) return;
  cleanups.push(observeSystemAppearance(() => useSettings.getState().settings));
  const restoreWorkspace = useSettings.getState().settings.restoreWorkspace !== false;

  if (!isTauri()) {
    useWorkspace.getState().ensureWelcome();
    return;
  }

  // Discover view contributions before restoring their tabs; discovery does not execute plugins.
  await Promise.all([usePluginSecurity.getState().load(), usePlugins.getState().load()]);
  if (signal.aborted) return;
  let restored = false;
  try {
    const records = await api.tabs();
    if (signal.aborted) return;
    // A slow snapshot must not replace tabs opened while startup is in progress.
    if (restoreWorkspace) {
      if (useWorkspace.getState().tabs === initialTabs) useWorkspace.getState().hydrate(records);
      restored = true;
    }
  } catch (error) {
    if (signal.aborted) return;
    toast(translateError(error), "error");
  }
  const hostsLoaded = await useHosts.getState().load();
  if (signal.aborted) return;
  if (hostsLoaded) pruneMissingHosts();
  await useSsh.getState().refresh();
  if (signal.aborted) return;
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
        await api.saveTabs(records);
      } catch (error) {
        toast(translateError(error), "error");
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
  const subscriptions: Subscription[] = [
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
          usePlugins.getState().apply(payload);
          if (payload.status === "failed" && payload.error)
            reportPluginExecutionFailure({ code: "validation", message: payload.error });
        }, signal),
      recover: () => usePlugins.getState().load(),
    },
    {
      register: (signal) =>
        events.onPluginSecurity((payload) => usePluginSecurity.getState().apply(payload), signal),
      recover: () => usePluginSecurity.getState().load(true),
    },
    {
      register: (signal) =>
        events.onTransfer((payload) => useTransfers.getState().apply(payload), signal),
      recover: () => useTransfers.getState().hydrate(),
    },
    {
      register: (signal) =>
        events.onSshClosed((payload) => {
          const known = useSsh
            .getState()
            .sessions.some((session) => session.id === payload.sessionId);
          useSsh.getState().forget(payload.sessionId);
          useMonitor.getState().forget(payload.sessionId);
          useWorkspace.getState().closeSession(payload.sessionId);
          if (known) toast(i18n.t("ssh.sessionEnded"), "info");
        }, signal),
      recover: () => useSsh.getState().refresh(),
    },
  ];
  const listeners = createEventLifecycle(subscriptions, (error) =>
    toast(translateError(error), "error"),
  );
  cleanups.push(() => listeners.dispose());
  await listeners.start();
}
