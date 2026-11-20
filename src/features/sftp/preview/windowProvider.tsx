import type { NativePreviewProviderDescriptor } from "@/lib/panels/windowProtocol";
import { createContext, useContext, type ComponentType, type ReactNode } from "react";
import { createResourceScope } from "@/lib/extensions/resourceScope";
import { openScopedFrontendView } from "@/lib/extensions/runtime/views/frontend";
import type { FrontendViewProps } from "@/lib/extensions/uiSdk";
import { guardFilePreviewProvider } from "@/lib/extensions/files/preview/provider";
import {
  createWindowProviderSource,
  type WindowProviderOwner,
} from "@/lib/panels/windowProviderSource";
import type { PreviewWindowData } from "./windowModel";
import { createWindowPreviewContext } from "./windowContext";

interface Frame {
  data: PreviewWindowData;
  Body: ComponentType;
  validate(): void;
  validateTarget(): void;
}
const Context = createContext<Frame | null>(null);
export function WindowPreviewProviderScope({
  value,
  children,
}: {
  value: Frame;
  children: ReactNode;
}) {
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function createWindowPreviewProviderSource(
  owner: WindowProviderOwner,
  report: (error: unknown) => void,
) {
  return createWindowProviderSource<NativePreviewProviderDescriptor>(owner, report, {
    key: (descriptor) => (descriptor ? JSON.stringify(descriptor) : null),
    describe: (client, target) => client.describePreviewProvider(target),
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
            const session = await client.openPreviewProvider(owner.target(), descriptor);
            token = session.token;
            return session;
          },
          check,
          state,
          signal,
        });
        const View = mounted.component;
        const access = (frame: Frame, mutation: boolean) => {
          if (mounted.resources.signal.aborted) throw new Error("plugin.frontend.expired");
          check();
          owner.check(mutation);
          if (mutation) frame.validate();
          else frame.validateTarget();
          if (frame.data.snapshot.source.kind !== descriptor.sourceKind)
            throw new Error("plugin.filePreview.changed");
        };
        // One stable Body type per attachment, never per metadata frame.
        function Body() {
          const frame = useContext(Context);
          if (!frame) throw new Error("plugin.filePreview.changed");
          access(frame, false);
          return <frame.Body />;
        }
        function PreviewProvider(props: FrontendViewProps) {
          const frame = useContext(Context);
          if (!frame) throw new Error("plugin.filePreview.changed");
          const checkAccess = (mutation = true) => access(frame, mutation);
          const context = createWindowPreviewContext(
            frame.data,
            () => {
              checkAccess(false);
              frame.validate();
            },
            (request) => {
              checkAccess();
              const target = owner.target();
              if (target.kind !== "owned") throw new Error("panel.window.staleOwner");
              const result = client
                .submitPreviewProviderAction(token!, target.lease, request)
                .then((receipt) => owner.client.receiveAction(receipt, mounted.resources.signal));
              // Existing v1 frontend actions are void. Preserve a runtime promise
              // for awaiters, but report rejections even when the caller ignores it.
              void result.catch(report);
              return result;
            },
          );
          return (
            <View
              {...props}
              resources={mounted.resources}
              filePreview={guardFilePreviewProvider(
                context,
                Body,
                checkAccess,
                () => descriptor.capabilities.write,
              )}
            />
          );
        }
        return { ...mounted, component: PreviewProvider, dispose: () => parent.dispose() };
      } catch (error) {
        parent.dispose();
        throw error;
      }
    },
  });
}
