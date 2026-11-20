import { createContext, useContext, type ReactNode } from "react";
import { createResourceScope } from "@/lib/extensions/resourceScope";
import { openScopedFrontendView } from "@/lib/extensions/runtime/views/frontend";
import type { FrontendViewProps } from "@/lib/extensions/uiSdk";
import {
  createWindowProviderSource,
  type WindowProviderOwner,
} from "@/lib/panels/windowProviderSource";
import {
  createBackgroundTasksContext,
  type BackgroundTasksContext,
} from "@/lib/extensions/backgroundTasks/context";
import { guardBackgroundTasksProvider } from "@/lib/extensions/backgroundTasks/provider";
import type { FrontendBackgroundTasks } from "@/lib/extensions/contracts/backgroundTasks/provider";
import type { BackgroundTaskEntry } from "@/lib/tasks/model";
import type { TaskPanelModel } from "@/lib/panels/taskModel";

type Frame = {
  context: BackgroundTasksContext & Pick<FrontendBackgroundTasks, "Entries">;
  entries: readonly BackgroundTaskEntry[];
  model: TaskPanelModel;
  validate(): boolean;
};
const Context = createContext<Frame | null>(null);
export function WindowTaskProviderScope({
  value,
  children,
}: {
  value: Frame;
  children: ReactNode;
}) {
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function createWindowTaskProviderSource(
  owner: WindowProviderOwner,
  report: (error: unknown) => void,
) {
  return createWindowProviderSource(owner, report, {
    describe: (client, target) => client.describeTasksProvider(target),
    async open(client, descriptor, signal, state, check, lifetime) {
      const parent = createResourceScope({ parent: lifetime, report });
      let token: string | undefined;
      try {
        const mounted = await openScopedFrontendView({
          owner: descriptor.view,
          viewId: descriptor.view.viewId,
          parent,
          transport: client.transport,
          openView: async () => {
            const session = await client.openTasksProvider(owner.target(), descriptor);
            token = session.token;
            return session;
          },
          check,
          state,
          signal,
        });
        const View = mounted.component;
        function TaskProvider(props: FrontendViewProps) {
          const frame = useContext(Context);
          if (!frame) throw new Error("plugin.backgroundTasks.changed");
          const access = (mutation = true) => {
            if (mounted.resources.signal.aborted) throw new Error("plugin.frontend.expired");
            check();
            owner.check(mutation);
          };
          const context = {
            Entries: frame.context.Entries,
            ...createBackgroundTasksContext(
              frame.context.snapshot,
              frame.entries,
              frame.validate,
              async (entry, actionId) => {
                access();
                const target = owner.target();
                if (target.kind !== "owned") throw new Error("panel.window.staleOwner");
                // Opaque incarnation ticket is host-only; never passed to props,
                // plugin snapshots, capture capsules or the public task API.
                const ticket = frame.model.viewKey(entry);
                const receipt = await client.submitTasksProviderAction(
                  token!,
                  target.lease,
                  entry.key,
                  ticket,
                  actionId,
                );
                await owner.client.receiveAction(receipt, mounted.resources.signal);
              },
            ),
          };
          const backgroundTasks = guardBackgroundTasksProvider(
            context,
            access,
            () => descriptor.capabilities.write,
          );
          return (
            <View {...props} resources={mounted.resources} backgroundTasks={backgroundTasks} />
          );
        }
        return { ...mounted, component: TaskProvider, dispose: () => parent.dispose() };
      } catch (error) {
        parent.dispose();
        throw error;
      }
    },
  });
}
