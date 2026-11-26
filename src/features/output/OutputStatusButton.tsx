import { panelPresentation } from "@/store/panelPresentation";
import { Logs } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNavigation } from "@/store/navigation";
import { useWorkspace } from "@/store/workspace";
import { sidebarTabId } from "@/lib/session/sidebarDock";
import "./output.css";

export function OutputStatusButton() {
  const { t } = useTranslation();
  const id = sidebarTabId("output");
  const docked = useWorkspace((state) => state.tabs.some((tab) => tab.id === id));
  const visible = useWorkspace(
    (state) =>
      state.tabs.some((tab) => tab.id === id && !tab.hidden) &&
      state.panes.some((pane) => pane.activeId === id),
  );
  const inSidebar = useNavigation(
    (state) => state.sidebarVisible && state.activeSidebar === "output",
  );
  const floating = panelPresentation("output")((state) => state.open);
  const expanded = docked ? visible : inSidebar || floating;
  return (
    <button
      type="button"
      className="statusbar__link statusbar__panel-button output-status"
      title={t("output.show")}
      aria-label={t("output.title")}
      aria-expanded={expanded}
      aria-controls="sidebar-output"
      data-panel-trigger="output"
      onClick={() => {
        if (floating) panelPresentation("output").getState().close();
        else if (docked) useWorkspace.getState().toggleDockedSidebar("output");
        else if (inSidebar) useNavigation.getState().selectSidebar("output");
        else useNavigation.getState().showOutput();
      }}
    >
      <Logs size={13} aria-hidden="true" />
      <span>{t("output.title")}</span>
    </button>
  );
}
