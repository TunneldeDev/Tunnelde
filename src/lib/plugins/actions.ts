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

type PluginAction = { id: string; view?: string; command?: string };

// A plugin has one runtime and its store serializes lifecycle operations. Queue
// distinct contributed actions so retained shortcut conflicts are not dropped
// while a previous action starts or invokes the same plugin.
const actionTails = new Map<string, Promise<void>>();

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
  const previous = actionTails.get(action.id) ?? Promise.resolve();
  const pending = previous
    .catch(() => {})
    .then(async () => {
      const current = usePlugins.getState().items.find((item) => item.id === action.id);
      if (
        !current ||
        current.fingerprint !== original.fingerprint ||
        current.version !== original.version
      )
        return;
      await invokePluginAction(action, target, hostTarget);
    });
  actionTails.set(action.id, pending);
  void pending
    .finally(() => {
      if (actionTails.get(action.id) === pending) actionTails.delete(action.id);
    })
    .catch(() => {});
  return pending;
}

async function invokePluginAction(
  action: PluginAction,
  target: ReturnType<typeof editorDocument>,
  hostTarget?: Host,
) {
  const store = usePlugins.getState();
  let plugin = store.items.find((item) => item.id === action.id);
  if (!plugin || plugin.runtime === "theme") return;
  if (hostTarget) {
    const command = hostMenuCommands([plugin]).find((item) => item.command === action.command);
    if (command) await runHostMenuCommand(command, hostTarget);
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
    );
    return;
  }
  if (plugin.status !== "running") await store.start(plugin.id);
  plugin = usePlugins.getState().items.find((item) => item.id === action.id);
  if (plugin?.status !== "running") return;
  const view = action.view ? plugin.views.find((item) => item.id === action.view) : undefined;
  if (view) {
    if (view.location === "sidebar")
      useNavigation.getState().showSidebar(pluginSidebarId(plugin.id, view.id));
    else useWorkspace.getState().openPluginView(plugin.id, view.id, view.title);
  } else if (action.command && plugin.commands.some((item) => item.id === action.command)) {
    // A host-owned result page also works for plugins without any contributed view.
    useWorkspace.getState().openPluginView(plugin.id, "$command", plugin.name);
    await usePlugins.getState().run(plugin.id, action.command);
  }
}
