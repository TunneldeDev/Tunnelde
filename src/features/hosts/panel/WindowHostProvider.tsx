import {
  Component,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  createWindowProviderSource,
  type WindowProviderOwner,
} from "@/lib/panels/windowProviderSource";
import { openScopedFrontendView } from "@/lib/extensions/runtime/views/frontend";
import { createResourceScope } from "@/lib/extensions/resourceScope";
import { useFactorySelection } from "@/lib/extensions/runtime/views/useFactorySelection";
import { usePanelReadiness } from "@/lib/panels/usePanelReadiness";
import { reportError } from "@/lib/diagnostics";
import { translateError } from "@/lib/api/errors";
import { Button } from "@/components/ui/form/Button";
import { useTranslation } from "react-i18next";

export function createWindowHostProviderSource(
  owner: WindowProviderOwner,
  report: (error: unknown) => void,
) {
  return createWindowProviderSource(owner, report, {
    describe: (client, target) => client.describeHostsProvider(target),
    async open(client, descriptor, signal, state, check, lifetime) {
      const parent = createResourceScope({ parent: lifetime, report });
      try {
        const mounted = await openScopedFrontendView({
          owner: descriptor.view,
          viewId: descriptor.view.viewId,
          parent,
          transport: client.transport,
          openView: () => client.openHostsProvider(owner.target(), descriptor),
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
class Boundary extends Component<
  { children: ReactNode; failed(error: unknown): ReactNode; onFailure(error: unknown): void },
  { error: { cause: unknown } | null }
> {
  override state = { error: null as { cause: unknown } | null };
  static getDerivedStateFromError(cause: unknown) {
    return { error: { cause } };
  }
  override componentDidCatch(error: unknown) {
    this.props.onFailure(error);
  }
  override render() {
    return this.state.error ? this.props.failed(this.state.error.cause) : this.props.children;
  }
}
export function WindowHostProvider({
  owner,
  children,
  visible,
}: {
  owner: WindowProviderOwner;
  children: ReactNode;
  visible: boolean;
}) {
  const { t } = useTranslation();
  const selection = useMemo(
    () =>
      createWindowHostProviderSource(owner, (error) =>
        reportError("panels.hosts", "provider", error),
      ),
    [owner],
  );
  const snapshot = useSyncExternalStore(selection.subscribe, selection.snapshot);
  const [failure, setFailure] = useState<{ id: string; cause: unknown } | null>(null);
  const selectionError = useFactorySelection(
    true,
    snapshot.source?.descriptor.view ?? null,
    snapshot.loading,
  );
  const cause =
    snapshot.error ??
    (failure?.id === snapshot.source?.id ? failure?.cause : undefined) ??
    selectionError;
  usePanelReadiness("hostList.selection", !snapshot.loading && cause === undefined, cause);
  useEffect(() => selection.start(), [selection]);
  const failed = (error: unknown) => (
    <div role="alert">
      <p>{translateError(error)}</p>
      <Button size="sm" onClick={selection.revalidate}>
        {t("common.retry")}
      </Button>
    </div>
  );
  const source = snapshot.source;
  const View = source?.View;
  return (
    <>
      {snapshot.error ? failed(snapshot.error) : null}
      <div className="provider-content" hidden={!!View && !failure}>
        {children}
      </div>
      {View && source ? (
        <div className="provider-content">
          <Boundary
            key={source.id}
            failed={failed}
            onFailure={(cause) => setFailure({ id: source.id, cause })}
          >
            <View
              pluginId={source.descriptor.view.pluginId}
              viewId={source.descriptor.view.viewId}
              visible={visible}
            />
          </Boundary>
        </div>
      ) : snapshot.loading ? (
        <p role="status">{t("common.loading")}</p>
      ) : null}
    </>
  );
}
