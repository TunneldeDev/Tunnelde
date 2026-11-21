import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/form/Button";
import { PanelHeader, useWorkbenchPanel } from "@/components/layout/WorkbenchPanel";
import type { PluginSidebarView } from "@/lib/plugins/sidebars";
import { parsePluginSidebar } from "@/lib/plugins/sidebars";
import { usePlugins } from "@/store/plugins";
import { PluginViewPage } from "./PluginViewPage";
import { PluginError } from "./PluginError";
import { pluginFailure } from "@/lib/plugins/errors";

export function PluginSidebarPanel({
  view,
  visible = true,
}: {
  view: PluginSidebarView;
  visible?: boolean;
}) {
  const { t } = useTranslation();
  const scope = useWorkbenchPanel();
  const reference = parsePluginSidebar(view)!;
  const plugin = usePlugins((state) => state.items.find((item) => item.id === reference.pluginId));
  const busy = usePlugins((state) => state.busyIds.includes(reference.pluginId));
  const starting = usePlugins((state) => state.startingIds.includes(reference.pluginId));
  const contribution = plugin?.views.find(
    (item) => item.id === reference.viewId && item.location === "sidebar",
  );
  return (
    <section
      className="plugin-sidebar-panel"
      aria-label={scope ? undefined : (contribution?.title ?? reference.viewId)}
    >
      <PanelHeader view={view} />
      {!plugin || !contribution ? (
        <p className="plugins-sidebar__empty">{t("pluginChat.missingView")}</p>
      ) : plugin.status !== "running" ? (
        <div className="plugins-sidebar__empty">
          <p>{t("pluginChat.startHint")}</p>
          {plugin.error ? <PluginError message={pluginFailure(new Error(plugin.error))} /> : null}
          <Button
            disabled={busy && !starting}
            onClick={() =>
              void (starting
                ? usePlugins.getState().stop(plugin.id)
                : usePlugins.getState().start(plugin.id))
            }
          >
            {t(starting ? "common.cancel" : "plugins.start")}
          </Button>
        </div>
      ) : (
        <PluginViewPage pluginId={plugin.id} viewId={contribution.id} visible={visible} embedded />
      )}
    </section>
  );
}
