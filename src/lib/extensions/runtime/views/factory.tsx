import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { FrontendViewProps } from "../../contracts/frontend/views";
import { ResourceScopeClosed } from "../scopes/errors";
import type { MountedFrontendView } from "./frontend";

/** One stable component per declared view, not a renderer recreated per snapshot.
 * Only the committed effect acquires a native view transport. Hidden retained
 * views keep their component/scope; removal aborts even a late acquisition.
 */
export function createFrontendFactoryComponent(
  open: (signal: AbortSignal) => Promise<MountedFrontendView | null>,
) {
  return function FrontendFactoryView(props: FrontendViewProps) {
    const { t } = useTranslation();
    const [mounted, setMounted] = useState<MountedFrontendView | null>(null);
    const [error, setError] = useState<unknown>(null);
    const parentSignal = props.resources?.signal;
    useEffect(() => {
      const controller = new AbortController();
      const abort = () => controller.abort();
      parentSignal?.addEventListener("abort", abort, { once: true });
      if (parentSignal?.aborted) abort();
      let current: MountedFrontendView | null = null;
      const retired = () => {
        if (!controller.signal.aborted) setError(new ResourceScopeClosed());
      };
      void open(controller.signal).then(
        (view) => {
          if (controller.signal.aborted) {
            view?.dispose();
            return;
          }
          if (!view) {
            setError(new Error("plugin.frontend.viewFactoryUnavailable"));
            return;
          }
          current = view;
          view.resources.signal.addEventListener("abort", retired, { once: true });
          if (view.resources.signal.aborted) retired();
          else setMounted(view);
        },
        (cause) => {
          if (!controller.signal.aborted) setError(cause);
        },
      );
      return () => {
        parentSignal?.removeEventListener("abort", abort);
        controller.abort();
        current?.resources.signal.removeEventListener("abort", retired);
        current?.dispose();
      };
    }, [parentSignal]);
    if (error) throw error;
    if (!mounted || mounted.resources.signal.aborted)
      return <p role="status">{t("common.loading")}</p>;
    const View = mounted.component;
    return <View {...props} resources={mounted.resources} />;
  };
}
