import type { PluginInfo } from "@/lib/api/types";
import { runWorkbenchCommand } from "@/lib/keyboard/actions";
import type { ShortcutCommand } from "@/lib/keyboard/registry";
import { openPluginAction } from "@/lib/plugins/actions";
import { useWorkspace } from "@/store/workspace";
import { editorDocument } from "@/store/editors";
import { usePlugins } from "@/store/plugins";

/** Capture the contribution and editor before a selection can wait for consent. */
export function quickAccessCommandAction(
  item: ShortcutCommand,
  plugins: readonly PluginInfo[],
  activeId: string | null,
) {
  const plugin = item.plugin ? plugins.find((p) => p.id === item.plugin!.id) : undefined;
  const document = activeId ? editorDocument(activeId) : null;
  return () => {
    if (
      (item.scope === "editor" || /^(tab|pane)\./.test(item.id)) &&
      useWorkspace.getState().activeId !== activeId
    )
      throw new Error("plugin.quickAccess.changed");
    if (item.plugin) {
      const latest = usePlugins.getState().items.find((p) => p.id === plugin?.id);
      if (
        !plugin ||
        !latest ||
        latest.fingerprint !== plugin.fingerprint ||
        latest.version !== plugin.version ||
        (item.plugin.command && !latest.commands.some((c) => c.id === item.plugin!.command)) ||
        (item.plugin.view && !latest.views.some((v) => v.id === item.plugin!.view && !v.provider))
      )
        throw new Error("plugin.quickAccess.changed");
      void openPluginAction(item.plugin, document);
    } else runWorkbenchCommand(item.id);
  };
}
