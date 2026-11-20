import { createResourceScope } from "@/lib/extensions/resourceScope";
import {
  createWindowProviderSource,
  type WindowProviderOwner,
} from "@/lib/panels/windowProviderSource";
import { openWindowForwardingProviderView } from "./windowProvider";

export type WindowForwardingViewOwner = WindowProviderOwner;
export function createWindowForwardingProviderSource(
  owner: WindowForwardingViewOwner,
  hostId: string,
  report: (error: unknown) => void,
) {
  return createWindowProviderSource(owner, report, {
    describe: (client, target) => client.describeForwardingProvider(target),
    async open(client, descriptor, signal, state, check, lifetime) {
      const parent = createResourceScope({ parent: lifetime, report });
      try {
        const mounted = await openWindowForwardingProviderView({
          client,
          target: owner.target(),
          descriptor,
          hostId,
          parent,
          check,
          state,
          signal,
        });
        return { ...mounted, dispose: () => parent.dispose() };
      } catch (error) {
        parent.dispose();
        throw error;
      }
    },
  });
}
