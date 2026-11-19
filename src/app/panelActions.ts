import { startWindowActions } from "@/lib/panels/windowActions";
import { createTaskProjection } from "@/lib/panels/taskProjection";
import { clearFinishedBackgroundTasks } from "@/lib/tasks/actions";
import { useSsh } from "@/store/ssh";
import { translateError } from "@/lib/api/errors";
import type { PanelWindowClient } from "@/lib/panels/windowClient";

export function startPanelActions(client: PanelWindowClient, failure: (error: unknown) => void) {
  const tasks = createTaskProjection();
  const executor = startWindowActions(
    client,
    async ({ request }) => {
      switch (request.kind) {
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
    tasks.dispose();
  };
}
