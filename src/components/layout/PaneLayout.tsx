import { useCallback } from "react";
import { useTranslation } from "react-i18next";
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
  const resize = useWorkspace((state) => state.resizeSplit);
  const onResize = useCallback((id: string, ratio: number) => resize(id, ratio), [resize]);
  return (
    <PanelLayout
      layout={visibleWorkspaceLayout(layout, panes, tabs)}
      renderPane={renderPane}
      onResize={onResize}
      resizeLabel={t("tab.resizeGroup")}
      className="pane-layout"
      childClassName="pane-layout__child"
    />
  );
}
