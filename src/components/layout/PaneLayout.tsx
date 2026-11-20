import { useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { canFloatTab } from "@/lib/plugins/presentation";
import { usePlugins } from "@/store/plugins";
import { PanelLayout } from "@/components/ui/layout/PanelLayout";
import { PaneView } from "@/components/layout/PaneView";
import { useWorkspace, visibleWorkspaceLayout } from "@/store/workspace";

function WorkspacePane({ paneId }: { paneId: string }) {
  const pane = useWorkspace((state) => state.panes.find((item) => item.id === paneId));
  const active = useWorkspace((state) => state.activePaneId === paneId);
  return pane ? <PaneView pane={pane} active={active} /> : null;
}

const renderPane = (paneId: string) => <WorkspacePane paneId={paneId} />;

/** Workspace store adapter; reusable layout has no dependency on application state. */
export function PaneLayout() {
  const { t } = useTranslation();
  const layout = useWorkspace((state) => state.layout);
  const panes = useWorkspace((state) => state.panes);
  const tabs = useWorkspace((state) => state.tabs);
  const resizeMany = useWorkspace((state) => state.resizeSplits);
  const resize = useWorkspace((state) => state.resizeSplit);
  const onResize = useCallback((id: string, ratio: number) => resize(id, ratio), [resize]);
  return (
    <PanelLayout
      layout={visibleWorkspaceLayout(layout, panes, tabs)}
      renderPane={renderPane}
      onResize={onResize}
      onResizeMany={resizeMany}
      resizeLabel={t("tab.resizeGroup")}
      className="pane-layout"
      childClassName="pane-layout__child"
    />
  );
}

/** Slots join the common floating layer; adapters share its stacking clock. */
export function FloatingWorkspaceLayer() {
  const panes = useWorkspace((state) => state.panes);
  const tabs = useWorkspace((state) => state.tabs);
  const plugins = usePlugins((state) => state.items);
  useEffect(() => {
    for (const pane of panes)
      if (
        pane.floating &&
        pane.tabIds.some((id) => {
          const tab = tabs.find((item) => item.id === id);
          return tab && !canFloatTab(tab);
        })
      )
        useWorkspace.getState().dockPane(pane.id);
  }, [panes, tabs, plugins]);
  const active = useWorkspace((state) => state.activePaneId);
  return panes
    .filter(
      (pane) =>
        pane.floating && pane.tabIds.some((id) => tabs.some((tab) => tab.id === id && !tab.hidden)),
    )
    .map((pane) => (
      <div
        className="workbench-floating-slot"
        key={pane.id}
        style={{ zIndex: pane.floating!.order + 1 }}
      >
        <PaneView pane={pane} active={pane.id === active} />
      </div>
    ));
}
