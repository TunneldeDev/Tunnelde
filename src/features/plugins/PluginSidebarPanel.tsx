import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/form/Button";
import { SidebarDockControls, SidebarTitle } from "@/components/layout/SidebarDockControls";
import type { PluginSidebarView } from "@/lib/plugins/sidebars";
import { parsePluginSidebar } from "@/lib/plugins/sidebars";
import { usePlugins } from "@/store/plugins";
import { useWorkspace } from "@/store/workspace";
import { sidebarTabId } from "@/lib/session/sidebarDock";
import { PluginViewPage } from "./PluginViewPage";
import { PluginError } from "./PluginError";
import { pluginFailure } from "@/lib/plugins/errors";

export function PluginSidebarPanel({ view }: { view: PluginSidebarView }) {
  const { t } = useTranslation();
  const reference = parsePluginSidebar(view)!;
  const plugin = usePlugins((state) => state.items.find((item) => item.id === reference.pluginId));
  const busy = usePlugins((state) => state.busyIds.includes(reference.pluginId));
  const docked = useWorkspace((state) => state.tabs.some((tab) => tab.id === sidebarTabId(view)));
  const contribution = plugin?.views.find(
    (item) => item.id === reference.viewId && item.location === "sidebar",
  );
  return (
    <section className="plugin-sidebar-panel" aria-label={contribution?.title ?? reference.viewId}>
      {!docked ? (
        <header className="sidebar__head">
          <SidebarTitle view={view}>{contribution?.title ?? reference.viewId}</SidebarTitle>
          <SidebarDockControls view={view} />
        </header>
      ) : null}
      {!plugin || !contribution ? (
        <p className="plugins-sidebar__empty">{t("pluginChat.missingView")}</p>
      ) : plugin.status !== "running" ? (
        <div className="plugins-sidebar__empty">
          <p>{t("pluginChat.startHint")}</p>
          {plugin.error ? <PluginError message={pluginFailure(new Error(plugin.error))} /> : null}
          <Button disabled={busy} onClick={() => void usePlugins.getState().start(plugin.id)}>
            {t("plugins.start")}
          </Button>
        </div>
      ) : (
        <PluginViewPage pluginId={plugin.id} viewId={contribution.id} embedded />
      )}
    </section>
  );
}
