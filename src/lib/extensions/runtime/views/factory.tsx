import { useFactoryPanelState } from "./factoryState";
import { useEffect, useLayoutEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { FrontendViewProps } from "../../contracts/frontend/views";
import { ResourceScopeClosed } from "../scopes/errors";
import type { MountedFrontendView } from "./frontend";

/** One stable component per declared view, not a renderer recreated per snapshot.
 * Only the committed effect acquires a native view transport. Hidden retained
 * views keep their component/scope; removal aborts even a late acquisition.
 */
export function createFrontendFactoryComponent(
  open: (signal: AbortSignal, state?: { value: unknown }) => Promise<MountedFrontendView | null>,
) {
  return function FrontendFactoryView(props: FrontendViewProps) {
    const { t } = useTranslation();
    const [mounted, setMounted] = useState<{
      view: MountedFrontendView;
      owner: ReturnType<typeof useFactoryPanelState>["current"]["current"];
    } | null>(null);
    const [error, setError] = useState<{ cause: unknown } | null>(null);
    const parentSignal = props.resources?.signal;
    const capture = useFactoryPanelState(props.pluginId, props.viewId, parentSignal);
    useLayoutEffect(() => {
      if (mounted) mounted.owner?.rendered(mounted.view);
    }, [mounted]);
    const initial = capture.initial;
    const binding = capture.current;
    useEffect(() => {
      const controller = new AbortController();
      const abort = () => controller.abort();
      parentSignal?.addEventListener("abort", abort, { once: true });
      if (parentSignal?.aborted) abort();
      let current: MountedFrontendView | null = null;
      const stateOwner = binding.current;
      const retired = () => {
        if (!controller.signal.aborted) {
          const error = new ResourceScopeClosed();
          stateOwner?.fail(error);
          setError({ cause: error });
        }
      };
      void open(controller.signal, initial).then(
        (view) => {
          if (controller.signal.aborted) {
            view?.dispose();
            return;
          }
          if (!view) {
            const error = new Error("plugin.frontend.viewFactoryUnavailable");
            stateOwner?.fail(error);
            setError({ cause: error });
            return;
          }
          current = view;
          view.resources.signal.addEventListener("abort", retired, { once: true });
          if (view.resources.signal.aborted) retired();
          else setMounted({ view, owner: stateOwner });
        },
        (cause) => {
          if (!controller.signal.aborted) {
            stateOwner?.fail(cause);
            setError({ cause });
          }
        },
      );
      return () => {
        parentSignal?.removeEventListener("abort", abort);
        controller.abort();
        current?.resources.signal.removeEventListener("abort", retired);
        current?.dispose();
      };
    }, [parentSignal, initial, binding]);
    if (error) throw error.cause;
    if (!mounted || mounted.view.resources.signal.aborted)
      return <p role="status">{t("common.loading")}</p>;
    const View = mounted.view.component;
    return <View {...props} resources={mounted.view.resources} />;
  };
}
