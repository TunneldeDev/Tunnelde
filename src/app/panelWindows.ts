import { initializePanelWindow, type PanelWindowClient } from "@/lib/panels/windowClient";
import { startPanelWindowCoordinator } from "@/lib/panels/windowCoordinator";
import { usePanelWindows } from "@/store/panelWindows";
import { usePlugins } from "@/store/plugins";
import { useFilePreview } from "@/store/filePreview";
import { SIDEBAR_VIEWS } from "@/lib/session/sidebarDock";
import { pluginSidebars } from "@/lib/plugins/sidebars";
import { reportError } from "@/lib/diagnostics";

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
  const coordinator = startPanelWindowCoordinator(current, {
    panelIds: () => [
      ...SIDEBAR_VIEWS.filter(
        (view) => view !== "filePreview" || useFilePreview.getState().file !== null,
      ),
      ...pluginSidebars(usePlugins.getState().items).map((item) => item.view),
    ],
    receive: (snapshot) =>
      usePanelWindows.setState({ windowId: current.windowId, available: true, snapshot }),
    failure: (error) => reportError("panels.windows", "coordinator", error),
  });
  const stop = [
    usePlugins.subscribe(coordinator.refresh),
    useFilePreview.subscribe(coordinator.refresh),
  ];
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    signal.removeEventListener("abort", dispose);
    for (const release of stop) release();
    coordinator.dispose();
    current.dispose();
    if (client === current) {
      client = null;
      usePanelWindows.setState({ available: false });
    }
  };
  signal.addEventListener("abort", dispose, { once: true });
  await coordinator.ready;
  return dispose;
}
