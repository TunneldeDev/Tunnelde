import { runnerRecoveryApi } from "@/lib/api/runners/recovery";
import { api } from "@/lib/api/ipc";
import { ConnectDialog } from "@/features/connect/ConnectDialog";
import { useRecoveryFiles } from "./useRecoveryFiles";
import { mainRecoveryPageServices } from "./mainPageServices";
import type { RunnerRecoveryServices } from "../data/services";
export const mainRunnerRecoveryServices: RunnerRecoveryServices = {
  ...mainRecoveryPageServices,
  client: runnerRecoveryApi,
  openLog: () => api.openLatestLog(),
  useFiles(pluginId) {
    const files = useRecoveryFiles(pluginId);
    return {
      pending: files.pending,
      error: files.error,
      browse: files.browse,
      renderConnection: () =>
        files.connection ? (
          <ConnectDialog
            host={files.connection.host}
            after="background"
            verification={files.verification}
            connectSession={files.connect}
            onConnected={files.connected}
            onClose={files.cancel}
          />
        ) : null,
    };
  },
};
