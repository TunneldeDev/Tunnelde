import {
  Component,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { presentError } from "@/lib/api/errors";
import { reportError } from "@/lib/diagnostics";
import { usePanelReadiness } from "@/lib/panels/usePanelReadiness";
import { useFactorySelection } from "@/lib/extensions/runtime/views/useFactorySelection";
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
  { children: ReactNode; failed(error: unknown): ReactNode; onFailure(error: unknown): void },
  { error: { cause: unknown } | null }
> {
  override state = { error: null as { cause: unknown } | null };
  static getDerivedStateFromError(cause: unknown) {
    return { error: { cause } };
  }
  override componentDidCatch(error: unknown) {
    reportError("panels.forwarding", "nativeProvider.render", error);
    this.props.onFailure(error);
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
  const [renderFailure, setRenderFailure] = useState<{ id: string; cause: unknown } | null>(null);
  const discoveryFailed = snapshot.error !== null;
  const selectionError = useFactorySelection(
    true,
    snapshot.source?.descriptor.view ?? null,
    snapshot.loading,
  );
  const cause =
    snapshot.error ??
    (renderFailure?.id === snapshot.source?.id ? renderFailure?.cause : undefined) ??
    selectionError;
  usePanelReadiness("forwarding.selection", !snapshot.loading && cause === undefined, cause);
  useEffect(() => selection.start(), [selection]);
  // The native invalidation may precede the coordinator's local lease commit.
  // Revalidate that commit too, without replacing the restored provider child.
  useEffect(() => selection.revalidate(), [selection, service]);
  const source = snapshot.source;
  const scopeOwner = useMemo(() => source && { service, check: source.check }, [source, service]);
  const failed = (error: unknown, retry = selection.refresh) => (
    <div role="alert">
      <p>{presentError(error)}</p>
      <Button size="sm" onClick={retry}>
        {t("common.retry")}
      </Button>
    </div>
  );
  if (!source)
    return discoveryFailed ? (
      failed(snapshot.error, selection.revalidate)
    ) : snapshot.loading ? (
      <p role="status">{t("common.loading")}</p>
    ) : (
      <context.Entries />
    );
  const View = source.View;
  return (
    <>
      {discoveryFailed ? failed(snapshot.error, selection.revalidate) : null}
      <Boundary
        key={source.id}
        failed={failed}
        onFailure={(cause) =>
          setRenderFailure({
            id: source.id,
            cause: cause ?? new Error("plugin.frontend.viewUnavailable"),
          })
        }
      >
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
