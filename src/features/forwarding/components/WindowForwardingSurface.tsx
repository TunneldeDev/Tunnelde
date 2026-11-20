import { Component, useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { translateError } from "@/lib/api/errors";
import { reportError } from "@/lib/diagnostics";
import { Button } from "@/components/ui/form/Button";
import {
  ForwardingSurfaceBody,
  type ForwardingSurfaceContext,
  type ForwardingSurfaceProps,
} from "./ForwardingSurface";
import {
  createWindowForwardingProviderSource,
  type WindowForwardingViewOwner,
} from "../runtime/windowProviderSource";
import { WindowForwardingProviderScope } from "../runtime/windowProvider";
import type { createWindowForwardingActions } from "../runtime/windowActions";

type Service = ReturnType<typeof createWindowForwardingActions>;
class Boundary extends Component<
  { children: ReactNode; failed(error: unknown): ReactNode },
  { error: { cause: unknown } | null }
> {
  override state = { error: null as { cause: unknown } | null };
  static getDerivedStateFromError(cause: unknown) {
    return { error: { cause } };
  }
  override componentDidCatch(error: unknown) {
    reportError("panels.forwarding", "nativeProvider.render", error);
  }
  override render() {
    return this.state.error ? this.props.failed(this.state.error.cause) : this.props.children;
  }
}
function SelectedProvider({
  owner,
  service,
  context,
  visible,
}: {
  owner: WindowForwardingViewOwner;
  service?: Service;
  context: ForwardingSurfaceContext;
  visible: boolean;
}) {
  const { t } = useTranslation();
  const selection = useMemo(
    () =>
      createWindowForwardingProviderSource(owner, context.snapshot.hostId, (error) =>
        reportError("panels.forwarding", "nativeProvider", error),
      ),
    [owner, context.snapshot.hostId],
  );
  const snapshot = useSyncExternalStore(selection.subscribe, selection.snapshot);
  useEffect(() => selection.start(), [selection]);
  const source = snapshot.source;
  const scopeOwner = useMemo(() => source && { service, check: source.check }, [source, service]);
  const failed = (error: unknown) => (
    <div role="alert">
      <p>{translateError(error)}</p>
      <Button size="sm" onClick={selection.refresh}>
        {t("common.retry")}
      </Button>
    </div>
  );
  if (!source)
    return snapshot.error ? (
      failed(snapshot.error)
    ) : snapshot.loading ? (
      <p role="status">{t("common.loading")}</p>
    ) : (
      <context.Entries />
    );
  const View = source.View;
  return (
    <>
      {snapshot.error ? failed(snapshot.error) : null}
      <Boundary key={source.id} failed={failed}>
        <WindowForwardingProviderScope value={{ owner: scopeOwner!, context }}>
          <View
            pluginId={source.descriptor.view.pluginId}
            viewId={source.descriptor.view.viewId}
            visible={visible}
          />
        </WindowForwardingProviderScope>
      </Boundary>
    </>
  );
}
/** Production native provider route, using the same persistent rows/editor
 * composition as the main window, but never its runtime/selection services. */
export function WindowForwardingSurface({
  owner,
  service,
  ...props
}: ForwardingSurfaceProps & { owner: WindowForwardingViewOwner; service?: Service }) {
  return (
    <ForwardingSurfaceBody
      {...props}
      renderProvider={(context, visible) => (
        <SelectedProvider owner={owner} service={service} context={context} visible={visible} />
      )}
    />
  );
}
