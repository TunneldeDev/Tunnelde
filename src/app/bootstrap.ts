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
import { wirePluginWorkspaceBridge } from "./pluginWorkspaceBridge";

let startup: Promise<void> | undefined;
let persistTimer: number | undefined;
let pendingRecords: TabRecord[] | undefined;
let saving = false;

export function bootstrap(): Promise<void> {
  return (startup ??= start());
}

async function start(): Promise<void> {
  const initialTabs = useWorkspace.getState().tabs;
  window.addEventListener("contextmenu", (event) => event.preventDefault());

  await useSettings.getState().load();
  observeSystemAppearance(() => useSettings.getState().settings);
  const restoreWorkspace = useSettings.getState().settings.restoreWorkspace !== false;

  if (!isTauri()) {
    useWorkspace.getState().ensureWelcome();
    return;
  }

  await wireEvents();
  // Discover view contributions before restoring their tabs; discovery does not execute plugins.
  await Promise.all([usePluginSecurity.getState().load(), usePlugins.getState().load()]);
  let restored = false;
  try {
    const records = await api.tabs();
    // A slow snapshot must not replace tabs opened while startup is in progress.
    if (restoreWorkspace) {
      if (useWorkspace.getState().tabs === initialTabs) useWorkspace.getState().hydrate(records);
      restored = true;
    }
  } catch (error) {
    toast(translateError(error), "error");
  }
  const hostsLoaded = await useHosts.getState().load();
  if (hostsLoaded) pruneMissingHosts();
  await useSsh.getState().refresh();
  useWorkspace.getState().ensureWelcome();

  useWorkspace.subscribe((state, previous) => {
    if (
      state.tabs === previous.tabs &&
      state.panes === previous.panes &&
      state.layout === previous.layout &&
      state.activePaneId === previous.activePaneId
    )
      return;
    schedulePersistence();
  });
  // Save pruned/normalized restoration, but never overwrite an unreadable snapshot.
  if (restored) schedulePersistence();
  await useUpdates.getState().refresh();
}

function schedulePersistence(): void {
  window.clearTimeout(persistTimer);
  persistTimer = window.setTimeout(() => {
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
  const listeners = await Promise.allSettled([
    wirePluginWorkspaceBridge(),
    events.onSettingsChanged((settings) => {
      useSettings.getState().applyRemote(settings);
    }),

    events.onUpdateState((state) => {
      useUpdates.getState().apply(state);
    }),

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
    }),

    events.onPluginState((payload) => {
      usePlugins.getState().apply(payload);
      if (payload.status === "failed" && payload.error)
        reportPluginExecutionFailure({ code: "validation", message: payload.error });
    }),
    events.onPluginSecurity((payload) => usePluginSecurity.getState().apply(payload)),

    events.onTransfer((payload) => {
      useTransfers.getState().apply(payload);
    }),

    events.onSshClosed((payload) => {
      const known = useSsh.getState().sessions.some((session) => session.id === payload.sessionId);
      useSsh.getState().forget(payload.sessionId);
      useMonitor.getState().forget(payload.sessionId);
      useWorkspace.getState().closeSession(payload.sessionId);
      if (known) toast(i18n.t("ssh.sessionEnded"), "info");
    }),
  ]);
  const failed = listeners.find((listener) => listener.status === "rejected");
  if (failed?.status === "rejected") toast(translateError(failed.reason), "error");
}
