import { useWorkspace } from "@/store/workspace";
import { useSsh } from "@/store/ssh";
import { useSettings } from "@/store/settings";
import { frontendRuntime } from "@/lib/extensions/frontendRuntime";
import { synchronizePluginAdapters } from "@/lib/panels/pluginAdapters";
import { startNativePluginUi } from "@/lib/panels/windowPluginUi";
import { startPresentationRequests } from "@/lib/panels/presentationRequests";
import { installPanelWindowDrag } from "@/lib/panels/windowDrag";
import { toast } from "@/store/toasts";
import { translateError } from "@/lib/api/errors";
import { initializePanelWindow, type PanelWindowClient } from "@/lib/panels/windowClient";
import { startPanelWindowCoordinator } from "@/lib/panels/windowCoordinator";
import { usePanelWindows } from "@/store/panelWindows";
import { usePlugins } from "@/store/plugins";
import { useFilePreview } from "@/store/filePreview";
import { SIDEBAR_VIEWS } from "@/lib/session/sidebarDock";
import { pluginSidebars } from "@/lib/plugins/sidebars";
import { reportError } from "@/lib/diagnostics";

import { createWindowViews, installWindowViews } from "@/lib/panels/windowViews";
import { createMainPanelPresentation } from "@/lib/panels/mainPresentation";
import {
  installSourcePanelPresentation,
  startSourcePanelFocus,
} from "@/lib/panels/sourcePresentation";
import { startPanelMoveRequests } from "@/lib/panels/windowMoveRequests";
import { startPanelActions } from "./panelActions";
import { startPanelReadModels } from "./panelReadModels";

let client: PanelWindowClient | null = null;
export const mainPanelWindowClient = () => client;
export async function startPanelWindows(signal: AbortSignal) {
  const current = await initializePanelWindow();
  if (signal.aborted) {
    current.dispose();
    return () => {};
  }
  if (current.windowId !== "main") {
    current.dispose();
    throw new Error("panel.window.coordinatorRequired");
  }
  client = current;
  const views = createWindowViews(current);
  const uninstallViews = installWindowViews(views);
  const failure = (error: unknown) => reportError("panels.windows", "coordinator", error);
  const coordinator = startPanelWindowCoordinator(current, {
    panelIds: () => [
      ...SIDEBAR_VIEWS.filter(
        (view) => view !== "filePreview" || useFilePreview.getState().file !== null,
      ),
      ...pluginSidebars(usePlugins.getState().items).map((item) => item.view),
      ...useWorkspace
        .getState()
        .tabs.filter(
          (tab) =>
            tab.kind === "terminal" &&
            (useSsh.getState().sessions.some((session) => tab.id === `terminal:${session.id}`) ||
              usePanelWindows
                .getState()
                .snapshot.terminalViews?.some((view) => view.panelId === tab.id)),
        )
        .map((tab) => tab.id),
    ],
    registerPanel: (id) =>
      id.startsWith("terminal:")
        ? current.terminals.bind(id.slice("terminal:".length))
        : current.control({ action: "addPanel", panelId: id }),
    synchronize: async (snapshot) => {
      const allow = !useSettings.getState().settings.uiProviders.terminal;
      for (const view of snapshot.terminalViews ?? [])
        if (view.allowMove !== allow) await current.terminals.configure(view.panelId, allow);
      await synchronizePluginAdapters(
        current.pluginViews(failure),
        snapshot,
        pluginSidebars(usePlugins.getState().items).flatMap((item) => {
          const owner = frontendRuntime.factoryOwner(item.pluginId, item.id);
          return owner ? [{ panelId: item.view, viewId: item.id, owner }] : [];
        }),
      );
    },
    receive: (snapshot) => {
      usePanelWindows.setState({ windowId: current.windowId, available: true, snapshot });
      void views.reconcile(snapshot).catch(failure);
    },
    stage: views.stage,
    failure,
  });
  const stop = [
    startNativePluginUi(current, failure),
    installSourcePanelPresentation(createMainPanelPresentation()),
    startPanelMoveRequests(current, failure),
    startPresentationRequests(current, failure),
    startSourcePanelFocus(current, failure),
    installPanelWindowDrag(current, (error) => toast(translateError(error), "error")),
    usePlugins.subscribe(coordinator.refresh),
    frontendRuntime.subscribe(coordinator.refresh),
    useFilePreview.subscribe(coordinator.refresh),
    useWorkspace.subscribe(coordinator.refresh),
    useSsh.subscribe(coordinator.refresh),
    useSettings.subscribe(coordinator.refresh),
  ];
  let stopModels = () => {};
  let stopActions = () => {};
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    signal.removeEventListener("abort", dispose);
    for (const release of stop) release();
    coordinator.dispose();
    stopModels();
    stopActions();
    uninstallViews();
    current.dispose();
    if (client === current) {
      client = null;
      usePanelWindows.setState({ available: false });
    }
  };
  signal.addEventListener("abort", dispose, { once: true });
  await coordinator.ready;
  // Registration is asynchronous; publish only after its initial reconciliation.
  if (!disposed) {
    const snapshot = await current.snapshot();
    if (snapshot.panels.some((p) => p.panelId === "connections")) {
      stopActions = startPanelActions(current, failure);
      stopModels = startPanelReadModels(current, failure);
    }
  }
  return dispose;
}
