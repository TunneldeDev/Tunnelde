import { executeTerminalWindowAction } from "@/features/terminal/terminalWindowActions";
import { executePluginListCommand } from "@/features/plugins/panel/actions";
import { executeHostPanelCommand } from "@/features/hosts/panel/execute";
import { executePreviewWindowAction } from "@/features/sftp/preview/windowActions";
import { createTransferWindowActions } from "@/features/sftp/transferWindowActions";
import { forwardingStore } from "@/features/forwarding/data/store";
import { forwardingGroupsStore } from "@/features/forwarding/data/groups";
import { useKnownHostsSource } from "@/features/settings/knownHosts/source";
import { useOutputSource } from "@/features/output/source";
import { api } from "@/lib/api/ipc";
import { startWindowActions } from "@/lib/panels/windowActions";
import { createTaskProjection } from "@/lib/panels/taskProjection";
import { clearFinishedBackgroundTasks } from "@/lib/tasks/actions";
import { useSsh } from "@/store/ssh";
import { translateError } from "@/lib/api/errors";
import type { PanelWindowClient } from "@/lib/panels/windowClient";

export function startPanelActions(client: PanelWindowClient, failure: (error: unknown) => void) {
  const tasks = createTaskProjection();
  const transfers = createTransferWindowActions(tasks, () => client.show());
  const executor = startWindowActions(
    client,
    async ({ request, lease }) => {
      switch (request.kind) {
        case "terminal":
          return executeTerminalWindowAction(lease, request.command, () => client.show());
        case "plugins":
          return executePluginListCommand(request.command, () => client.show());
        case "hosts":
          return executeHostPanelCommand(request.command, () => client.show());
        case "preview":
          return executePreviewWindowAction(lease, request);
        case "refreshForwarding":
          forwardingStore.refresh();
          forwardingGroupsStore.refresh();
          return null;
        case "transfer":
        case "transferResume":
        case "transferPrompt":
          try {
            return await transfers.execute(lease, request);
          } catch (error) {
            // Keep review/key identifiers machine-readable for the shared
            // prompt; translate only at the originating window.
            if (error && typeof error === "object" && "message" in error)
              throw new Error(String(error.message));
            throw new Error(translateError(error));
          }
        case "refreshKnownHosts":
        case "forgetKnownHost": {
          const source = useKnownHostsSource.getState().source;
          if (!source) throw new Error("panel.window.disposed");
          try {
            if (request.kind === "refreshKnownHosts") await source.refresh();
            else await source.forget(request.entry);
          } catch (error) {
            throw new Error(translateError(error));
          }
          return null;
        }
        case "output": {
          const source = useOutputSource.getState().source;
          if (!source) throw new Error("panel.window.disposed");
          switch (request.operation) {
            case "refresh":
              await source.refresh();
              break;
            case "clear":
              source.clear();
              break;
            case "openLatest":
              await api.openLatestLog();
              break;
            case "openDirectory":
              await api.openLogDir();
              break;
          }
          return null;
        }
        case "copyOutput":
          await api.clipboardWriteText(request.text);
          return null;
        case "task":
          try {
            return await tasks.run(request.key, request.ticket, request.actionId);
          } catch (error) {
            throw new Error(translateError(error));
          }
        case "clearTasks": {
          const errors = await clearFinishedBackgroundTasks();
          return {
            count: errors.length,
            first: errors[0] === undefined ? undefined : translateError(errors[0]).slice(0, 4096),
          };
        }
        case "disconnect": {
          let failure: unknown,
            failed = false;
          await useSsh.getState().disconnect(request.sessionId, (error) => {
            failed = true;
            failure = error;
          });
          if (failed) throw new Error(translateError(failure));
          return null;
        }
      }
    },
    failure,
  );
  return () => {
    executor.dispose();
    transfers.dispose();
    tasks.dispose();
  };
}
