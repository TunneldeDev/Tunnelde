import { useDialogs } from "@/store/dialogs";
import { useNavigation } from "@/store/navigation";
import { useSettings } from "@/store/settings";
import { useUpdates } from "@/store/updates";
import { useWorkspace } from "@/store/workspace";
import { closeTab } from "@/lib/session/tabActions";
import { DEFAULT_SETTINGS, MONO_FONT_SIZE_MAX, MONO_FONT_SIZE_MIN } from "@/lib/prefs/defaults";

/** One action implementation for keyboard and command-palette invocation. */
export function runWorkbenchCommand(id: string, openPalette?: () => void): boolean {
  const workspace = useWorkspace.getState();
  const settings = useSettings.getState();
  if (id === "palette.open") openPalette?.();
  else if (id === "keyboard.shortcuts") {
    useNavigation.getState().selectSettings("shortcuts");
    workspace.openPage("settings");
  } else if (id === "page.settings" || id === "page.welcome" || id === "page.about")
    workspace.openPage(id.slice(5) as "settings" | "welcome" | "about");
  else if (id === "host.new") useDialogs.getState().openHost();
  else if (id === "sidebar.toggle") useNavigation.getState().toggleSidebar();
  else if (id === "sidebar.knownHosts") useNavigation.getState().showSidebar("knownHosts");
  else if (id === "sidebar.plugins") useNavigation.getState().showSidebar("plugins");
  else if (id === "update.check") void useUpdates.getState().check(true);
  else if (id === "panel.toggle")
    void settings.update({ rightPanel: !settings.settings.rightPanel });
  else if (id === "theme.cycle")
    void settings.update({
      theme:
        settings.settings.theme === "dark"
          ? "light"
          : settings.settings.theme === "light"
            ? "system"
            : "dark",
    });
  else if (id.startsWith("font.")) {
    const next =
      id === "font.reset"
        ? (settings.info?.defaultSettings?.monoFontSize ?? DEFAULT_SETTINGS.monoFontSize)
        : Math.min(
            MONO_FONT_SIZE_MAX,
            Math.max(
              MONO_FONT_SIZE_MIN,
              settings.settings.monoFontSize + (id === "font.decrease" ? -1 : 1),
            ),
          );
    if (next !== settings.settings.monoFontSize) void settings.update({ monoFontSize: next });
  } else if (id === "pane.close" && workspace.panes.length > 1)
    workspace.closePane(workspace.activePaneId);
  else if (id === "tab.close" || id === "pane.close") {
    const tab = workspace.tabs.find((item) => item.id === workspace.activeId);
    if (tab) closeTab(tab);
  } else if (id === "tab.splitRight" || id === "tab.splitDown") {
    if (workspace.activeId)
      workspace.splitTab(workspace.activeId, id === "tab.splitDown" ? "column" : "row");
  } else if (id === "tab.next" || id === "tab.previous") {
    const pane = workspace.panes.find((item) => item.id === workspace.activePaneId);
    const ids = (pane?.tabIds ?? []).filter((id) =>
      workspace.tabs.some((tab) => tab.id === id && !tab.hidden),
    );
    const next =
      (ids.indexOf(workspace.activeId ?? "") + (id === "tab.previous" ? -1 : 1) + ids.length) %
      ids.length;
    if (ids[next]) workspace.activate(ids[next]);
  } else if (/^tab\.focus[1-9]$/.test(id)) {
    const pane = workspace.panes.find((item) => item.id === workspace.activePaneId);
    const visible = (pane?.tabIds ?? []).filter((tabId) =>
      workspace.tabs.some((tab) => tab.id === tabId && !tab.hidden),
    );
    const target = visible[Number(id.slice(-1)) - 1];
    if (target) workspace.activate(target);
  } else return false;
  return true;
}
