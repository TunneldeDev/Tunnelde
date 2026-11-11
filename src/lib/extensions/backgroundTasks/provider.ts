import type { FrontendBackgroundTasks } from "../contracts/backgroundTasks/provider";
import type { CheckProviderAccess } from "../runtime/providers/access";
import type { BackgroundTasksContext } from "./context";

export function guardBackgroundTasksProvider(
  context: BackgroundTasksContext & Pick<FrontendBackgroundTasks, "Entries">,
  checkAccess: CheckProviderAccess,
  canAct: () => boolean,
): FrontendBackgroundTasks {
  return Object.freeze({
    Entries: context.Entries,
    snapshot: context.snapshot,
    capabilities: Object.freeze({ actions: canAct() }),
    read: (request) => {
      checkAccess(false);
      return context.read(request);
    },
    runAction: async (request) => {
      checkAccess();
      if (!canAct()) throw new Error("plugin.permission:backgroundTasks.write");
      await context.runAction(request);
    },
  } satisfies FrontendBackgroundTasks);
}
