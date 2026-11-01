import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import i18n from "@/i18n/i18n";
import { api } from "@/lib/api/ipc";
import { closeTab } from "@/lib/session/tabActions";
import { sidebarTabId, sidebarViewOf } from "@/lib/session/sidebarDock";
import { useDialogs } from "@/store/dialogs";
import { useEditors } from "@/store/editors";
import { useHosts } from "@/store/hosts";
import { usePlugins } from "@/store/plugins";
import { useSsh } from "@/store/ssh";
import { toast, type ToastVariant } from "@/store/toasts";
import { useWorkspace, type PageKind } from "@/store/workspace";

export interface PluginWorkspaceRequest {
  requestId: string;
  pluginId: string;
  method: string;
  params: Record<string, unknown>;
}

const PAGES: PageKind[] = ["welcome", "settings", "about", "updates", "knownHosts"];
function text(params: Record<string, unknown>, key: string, limit = 1024): string {
  const value = params[key];
  if (typeof value !== "string" || !value || value.length > limit || value.includes("\0"))
    throw new Error(`invalid:${key}`);
  return value;
}
function optionalText(params: Record<string, unknown>, key: string): string | undefined {
  return params[key] == null ? undefined : text(params, key);
}
function sidebar(params: Record<string, unknown>) {
  const view = text(params, "view");
  const result = sidebarViewOf(sidebarTabId(view as Parameters<typeof sidebarTabId>[0]));
  if (!result) throw new Error("invalid:view");
  return result;
}
const authorize = (requestId: string) => invoke<void>("plugin_workspace_authorize", { requestId });
const pendingConfirmations = new Map<string, () => void>();

/** Read current state; never use the persisted, potentially delayed tab snapshot. */
export function pluginWorkspaceSnapshot() {
  const { tabs, panes, activeId, activePaneId, layout } = useWorkspace.getState();
  return { tabs, panes, activeId, activePaneId, layout };
}

export async function runPluginWorkspaceRequest(request: PluginWorkspaceRequest): Promise<unknown> {
  await authorize(request.requestId);
  const { method, params } = request;
  const workspace = useWorkspace.getState();
  switch (method) {
    case "workspace.snapshot":
      return pluginWorkspaceSnapshot();
    case "workspace.openPage": {
      const kind = text(params, "kind");
      const page = PAGES.find((item) => item === kind);
      if (!page) throw new Error("invalid:kind");
      workspace.openPage(page);
      break;
    }
    case "workspace.openHost": {
      const hostId = text(params, "hostId");
      const snapshot = await api.hostsSnapshot();
      await authorize(request.requestId);
      const host = snapshot.hosts.find((item) => item.id === hostId);
      if (!host) throw new Error("host.notFound");
      useHosts.setState({ ...snapshot, loaded: true });
      useWorkspace.getState().openHost(host);
      break;
    }
    case "workspace.openTerminal":
    case "workspace.openFiles": {
      const sessionId = text(params, "sessionId");
      const sessions = await api.sshSessions();
      await authorize(request.requestId);
      const session = sessions.find((item) => item.id === sessionId);
      if (!session) throw new Error("ssh.sessionMissing");
      useSsh.setState({ sessions });
      if (method === "workspace.openTerminal") useWorkspace.getState().openTerminal(session);
      else useWorkspace.getState().openSftp(session);
      break;
    }
    case "workspace.openSidebar":
      workspace.openSidebar(sidebar(params));
      break;
    case "workspace.returnSidebar":
      workspace.returnSidebar(sidebar(params));
      break;
    case "workspace.activate": {
      const tabId = text(params, "tabId");
      if (!workspace.tabs.some((tab) => tab.id === tabId)) throw new Error("tab.notFound");
      workspace.activate(tabId);
      break;
    }
    case "workspace.close": {
      const tabId = text(params, "tabId");
      const tab = workspace.tabs.find((item) => item.id === tabId);
      if (!tab) throw new Error("tab.notFound");
      const dirty = tab.kind === "editor" && useEditors.getState().isDirty(tabId);
      if (dirty && useDialogs.getState().dialog.kind !== "none") throw new Error("dialog.busy");
      closeTab(tab);
      return {
        closed: !useWorkspace.getState().tabs.some((item) => item.id === tabId),
        pendingConfirmation: dirty,
      };
    }
    case "workspace.split": {
      const tabId = text(params, "tabId"),
        direction = text(params, "direction");
      const position = optionalText(params, "position") ?? "after";
      const target = optionalText(params, "targetPaneId");
      if (direction !== "row" && direction !== "column") throw new Error("invalid:direction");
      if (position !== "before" && position !== "after") throw new Error("invalid:position");
      if (!workspace.tabs.some((tab) => tab.id === tabId)) throw new Error("tab.notFound");
      if (target && target !== "root" && !workspace.panes.some((pane) => pane.id === target))
        throw new Error("pane.notFound");
      workspace.splitTab(tabId, direction, position, target);
      break;
    }
    case "workspace.move": {
      const tabId = text(params, "tabId"),
        paneId = text(params, "paneId");
      const before = optionalText(params, "beforeTabId");
      if (!workspace.tabs.some((tab) => tab.id === tabId)) throw new Error("tab.notFound");
      const pane = workspace.panes.find((item) => item.id === paneId);
      if (!pane || (before && !pane.tabIds.includes(before))) throw new Error("pane.notFound");
      workspace.moveTab(tabId, paneId, before);
      break;
    }
    case "ui.showMessage": {
      const message = text(params, "message", 4000),
        kind = optionalText(params, "kind") ?? "info";
      if (!["info", "success", "error"].includes(kind)) throw new Error("invalid:kind");
      const name =
        usePlugins.getState().items.find((plugin) => plugin.id === request.pluginId)?.name ??
        request.pluginId;
      toast(`${i18n.t("pluginApi.messageTitle", { name })}: ${message}`, kind as ToastVariant);
      return null;
    }
    case "ui.confirm":
      return confirmPlugin(
        request.requestId,
        request.pluginId,
        text(params, "message", 220 * 1024),
      );
    default:
      throw new Error("unknownMethod");
  }
  return pluginWorkspaceSnapshot();
}

function confirmPlugin(requestId: string, pluginId: string, message: string): Promise<boolean> {
  if (useDialogs.getState().dialog.kind !== "none") throw new Error("dialog.busy");
  const name =
    usePlugins.getState().items.find((plugin) => plugin.id === pluginId)?.name ?? pluginId;
  return new Promise((resolve) => {
    let complete = false;
    let unsubscribe = () => {};
    const finish = (value: boolean) => {
      if (complete) return;
      complete = true;
      pendingConfirmations.delete(requestId);
      window.clearTimeout(timer);
      unsubscribe();
      resolve(value);
    };
    const timer = window.setTimeout(() => {
      finish(false);
      if (useDialogs.getState().dialog === dialog) useDialogs.getState().close();
    }, 55_000);
    useDialogs.getState().confirm({
      title: i18n.t("pluginApi.confirmTitle", { name }),
      body: message,
      preformatted: true,
      confirmLabel: i18n.t("pluginApi.confirm"),
      onConfirm: () => finish(true),
    });
    const dialog = useDialogs.getState().dialog;
    pendingConfirmations.set(requestId, () => {
      finish(false);
      if (useDialogs.getState().dialog === dialog) useDialogs.getState().close();
    });
    unsubscribe = useDialogs.subscribe((state) => {
      if (state.dialog !== dialog) finish(false);
    });
  });
}

export async function wirePluginWorkspaceBridge(): Promise<UnlistenFn> {
  const registrations = await Promise.allSettled([
    listen<PluginWorkspaceRequest>("plugin://workspace-request", ({ payload }) => {
      void (async () => {
        try {
          const result = await runPluginWorkspaceRequest(payload);
          await invoke("plugin_workspace_reply", {
            requestId: payload.requestId,
            result,
            error: null,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : "requestFailed";
          await invoke("plugin_workspace_reply", {
            requestId: payload.requestId,
            result: null,
            error: message,
          }).catch(() => {});
        }
      })();
    }),
    listen<{ requestId: string }>("plugin://workspace-cancelled", ({ payload }) => {
      pendingConfirmations.get(payload.requestId)?.();
    }),
    listen<{ domain: string; sessionId?: string | null }>(
      "plugin://domain-changed",
      ({ payload }) => {
        if (payload.domain === "hosts")
          void useHosts
            .getState()
            .load()
            .then((loaded) => {
              if (!loaded) return;
              const current = useHosts.getState().hosts;
              for (const tab of useWorkspace.getState().tabs) {
                if (tab.kind !== "host" || !tab.hostId) continue;
                const host = current.find((item) => item.id === tab.hostId);
                if (host) useWorkspace.getState().renameHost(host.id, host.name);
                else useWorkspace.getState().removeHost(tab.hostId);
              }
            });
        if (payload.domain === "sessions") void useSsh.getState().refresh();
        if (payload.domain === "history")
          window.dispatchEvent(new Event("tunnelde:history-changed"));
        if (payload.domain === "files")
          window.dispatchEvent(
            new CustomEvent("tunnelde:files-changed", {
              detail: {
                source: payload.sessionId
                  ? { kind: "remote", sessionId: payload.sessionId }
                  : { kind: "local" },
                origin: "plugin-api",
              },
            }),
          );
      },
    ),
  ]);
  let disposed = false;
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    for (const item of registrations) if (item.status === "fulfilled") item.value();
    for (const cancel of pendingConfirmations.values()) cancel();
  };
  const failed = registrations.find((item) => item.status === "rejected");
  if (failed?.status === "rejected") {
    cleanup();
    throw failed.reason;
  }
  return cleanup;
}
