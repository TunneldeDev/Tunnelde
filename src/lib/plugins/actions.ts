import { usePlugins } from "@/store/plugins";
import { useWorkspace } from "@/store/workspace";
import { useNavigation } from "@/store/navigation";
import { pluginSidebarId } from "./sidebars";
import { editorDocument } from "@/store/editors";
import { runEditorPlugin } from "./formatting";
import { toast } from "@/store/toasts";
import i18n from "@/i18n/i18n";

/** Metadata can be searched without starting code. Runtime consent happens on invocation. */
export async function openPluginAction(action: { id: string; view?: string; command?: string }) {
  const store = usePlugins.getState();
  let plugin = store.items.find((item) => item.id === action.id);
  if (!plugin || plugin.runtime === "theme") return;
  const editorCommand = action.command
    ? plugin.commands.find((item) => item.id === action.command && item.editor)
    : null;
  if (editorCommand) {
    const activeId = useWorkspace.getState().activeId;
    const document = activeId ? editorDocument(activeId) : null;
    if (!document) {
      toast(i18n.t("editor.noDocument"), "info");
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
