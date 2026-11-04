import { registerBackgroundTaskSource, type BackgroundTask } from "@/lib/tasks/background";
import { registerTaskPresentation } from "@/features/tasks/presentation";
import { TransferBackgroundTask } from "@/features/sftp/TransferBackgroundTask";
import { useTransfers } from "@/store/transfers";
import { useMarketplace } from "@/store/marketplace";
import { usePlugins } from "@/store/plugins";
import i18n from "@/i18n/i18n";

const PHASE_KEYS = {
  connecting: "market.phase.connecting",
  downloading: "market.phase.downloading",
  downloaded: "market.phase.downloaded",
  verifying: "market.phase.verifying",
  installing: "market.phase.installing",
  done: "market.phase.done",
} as const;

/** Feature adapters provide snapshots; the shared panel never imports their stores. */
export function registerBackgroundTaskSources(): () => void {
  const stopView = registerTaskPresentation("transfers", TransferBackgroundTask);
  const cleanups = [stopView];
  try {
    cleanups.push(
      registerBackgroundTaskSource({
        id: "transfers",
        subscribe: (listener) => useTransfers.subscribe(listener),
        snapshot: () =>
          useTransfers.getState().items.map(
            (item) =>
              ({
                id: item.id,
                title: item.name,
                status: ["failed", "cleanupPending"].includes(item.status)
                  ? "attention"
                  : item.status,
                updatedAt: item.updatedAt,
                execution: "native",
                progress: { completed: item.transferred, total: item.total, unit: "bytes" },
                actions: ["done", "cancelled", "failed"].includes(item.status)
                  ? [
                      {
                        id: "clear",
                        label: "",
                        disabled: item.clearing,
                        run: () => useTransfers.getState().clear(item.id),
                      },
                    ]
                  : [],
              }) as BackgroundTask,
          ),
      }),
    );
    cleanups.push(
      registerBackgroundTaskSource({
        id: "marketplace",
        subscribe: (listener) => {
          const stop = useMarketplace.subscribe(listener);
          i18n.on("languageChanged", listener);
          return () => {
            stop();
            i18n.off("languageChanged", listener);
          };
        },
        snapshot: () =>
          Object.entries(useMarketplace.getState().tasks).map(([id, task]) => {
            const name =
              Object.values(useMarketplace.getState().catalogues)
                .flatMap((catalogue) => catalogue.entries)
                .find((entry) => entry.id === id)?.name ??
              usePlugins.getState().items.find((plugin) => plugin.id === id)?.name ??
              id;
            return {
              id: task.taskId,
              title: i18n.t("tasks.installPlugin", { name }),
              status:
                task.phase === "failed"
                  ? "attention"
                  : task.phase === "done"
                    ? "done"
                    : task.phase === "cancelled"
                      ? "cancelled"
                      : "running",
              execution: "webview",
              updatedAt: 0,
              progress: { completed: task.received, total: task.total, unit: "bytes" },
              message: i18n.t(
                PHASE_KEYS[task.phase as keyof typeof PHASE_KEYS] ?? "market.phase.connecting",
              ),
              actions: ["done", "failed", "cancelled"].includes(task.phase)
                ? []
                : [
                    {
                      id: "cancel",
                      label: "",
                      disabled: useMarketplace.getState().cancelling.includes(id),
                      run: () => useMarketplace.getState().cancel(id),
                    },
                  ],
            };
          }),
      }),
    );
  } catch (error) {
    for (const dispose of cleanups.reverse()) dispose();
    throw error;
  }
  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    for (const dispose of cleanups.reverse()) dispose();
  };
}
