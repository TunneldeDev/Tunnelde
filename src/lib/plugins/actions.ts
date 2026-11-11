import { enqueuePluginAction } from "./commands/queue";
import { translateError } from "@/lib/api/errors";
import { usePlugins } from "@/store/plugins";
import { useWorkspace } from "@/store/workspace";
import { useNavigation } from "@/store/navigation";
import { useHosts } from "@/store/hosts";
import type { Host } from "@/lib/api/types";
import { hostMenuCommands, runHostMenuCommand } from "./hostMenu";
import { pluginSidebarId } from "./sidebars";
import { editorDocument } from "@/store/editors";
import { runEditorPlugin } from "./formatting";
import { toast } from "@/store/toasts";
import i18n from "@/i18n/i18n";
import { samePluginAction, type PluginActionTarget } from "./commands/identity";
import { invokeContributedCommand } from "./commands/invoke";
import type { PluginInfo } from "@/lib/api/types";

type PluginAction = PluginActionTarget;

/** Metadata can be searched without starting code. Runtime consent happens on invocation. */
export function openPluginAction(
  action: PluginAction,
  requestedDocument?: ReturnType<typeof editorDocument>,
): Promise<void> {
  const original = usePlugins.getState().items.find((item) => item.id === action.id);
  if (!original) return Promise.resolve();
  const isEditor = original.commands.some((item) => item.id === action.command && item.editor);
  const isHost = original.commands.some((item) => item.id === action.command && item.hostMenu);
  const activeId = useWorkspace.getState().activeId;
  const hostId = useWorkspace.getState().tabs.find((tab) => tab.id === activeId)?.hostId;
  const hostTarget = isHost
    ? useHosts.getState().hosts.find((host) => host.id === hostId)
    : undefined;
  if (isHost && !hostTarget) {
    toast(i18n.t("pluginView.hostRequired"), "info");
    return Promise.resolve();
  }
  const target = isEditor
    ? requestedDocument !== undefined
      ? requestedDocument
      : activeId
        ? editorDocument(activeId)
        : null
    : null;
  if (isEditor && !target) {
    toast(i18n.t("editor.noDocument"), "info");
    return Promise.resolve();
  }
  return enqueuePluginAction(original, async (signal) => {
    const current = usePlugins.getState().items.find((item) => item.id === action.id);
    if (!samePluginAction(current, original, action)) return;
    await invokePluginAction(action, target, original, hostTarget, signal);
  }).catch((error: unknown) => {
    toast(translateError(error), "error");
  });
}

async function invokePluginAction(
  action: PluginAction,
  target: ReturnType<typeof editorDocument>,
  original: PluginInfo,
  hostTarget?: Host,
  signal?: AbortSignal,
) {
  if (signal?.aborted) return;
  const store = usePlugins.getState();
  let plugin = store.items.find((item) => item.id === action.id);
  if (!plugin || plugin.runtime === "theme") return;
  if (hostTarget) {
    const command = hostMenuCommands([plugin]).find((item) => item.command === action.command);
    if (command) await runHostMenuCommand(command, hostTarget, signal);
    return;
  }
  const editorCommand = action.command
    ? plugin.commands.find((item) => item.id === action.command && item.editor)
    : null;
  if (editorCommand) {
    const document = target ? editorDocument(target.tabId) : null;
    if (!document || document.documentId !== target?.documentId) {
      toast(i18n.t("editor.documentChanged"), "error");
      return;
    }
    await runEditorPlugin(
      { id: plugin.id, command: editorCommand.id, title: editorCommand.title },
      document,
      signal,
    );
    return;
  }
  if (plugin.status !== "running") await store.start(plugin.id);
  if (signal?.aborted) return;
  plugin = usePlugins.getState().items.find((item) => item.id === action.id);
  if (!samePluginAction(plugin, original, action) || plugin.status !== "running") return;
  const view = action.view
    ? plugin.views.find((item) => item.id === action.view && !item.provider)
    : undefined;
  if (view) {
    if (view.location === "sidebar")
      useNavigation.getState().showSidebar(pluginSidebarId(plugin.id, view.id));
    else useWorkspace.getState().openPluginView(plugin.id, view.id, view.title);
  } else if (action.command && plugin.commands.some((item) => item.id === action.command)) {
    await invokeContributedCommand(plugin, action, signal);
  }
}
