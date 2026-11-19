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
    ],
    receive: (snapshot) => {
      usePanelWindows.setState({ windowId: current.windowId, available: true, snapshot });
      void views.reconcile(snapshot).catch(failure);
    },
    stage: views.stage,
    failure,
  });
  const stop = [
    installPanelWindowDrag(current, (error) => toast(translateError(error), "error")),
    usePlugins.subscribe(coordinator.refresh),
    useFilePreview.subscribe(coordinator.refresh),
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
