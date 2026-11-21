import { PluginsSection } from "@/features/plugins/PluginsSection";

import { PluginPanelDialogs } from "./panel/PluginPanelDialogs";
export function PluginsSidebar({ dialogs = true }: { dialogs?: boolean }) {
  return (
    <>
      <PluginsSection sidebar />
      {dialogs ? <PluginPanelDialogs /> : null}
    </>
  );
}
