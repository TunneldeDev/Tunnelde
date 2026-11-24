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
import type { BackgroundTasksContext } from "@/lib/extensions/backgroundTasks/context";
import type { FrontendBackgroundTasks } from "@/lib/extensions/contracts/backgroundTasks/provider";
import type { BackgroundTaskEntry } from "@/lib/tasks/model";
import type { TaskPanelModel } from "@/lib/panels/taskModel";
import type { WindowProviderOwner } from "@/lib/panels/windowProviderSource";
import { createWindowTaskProviderSource, WindowTaskProviderScope } from "../runtime/windowProvider";
class Boundary extends Component<
  { children: ReactNode; failed(error: unknown): ReactNode; onFailure(error: unknown): void },
  { error: { cause: unknown } | null }
> {
  override state = { error: null as { cause: unknown } | null };
  static getDerivedStateFromError(cause: unknown) {
    return { error: { cause } };
  }
  override componentDidCatch(error: unknown) {
    reportError("panels.tasks", "nativeProvider.render", error);
    this.props.onFailure(error);
  }
  override render() {
    return this.state.error ? this.props.failed(this.state.error.cause) : this.props.children;
  }
}
export function WindowTaskProvider({
  owner,
  context,
  entries,
  model,
  validate,
  visible,
}: {
  owner: WindowProviderOwner;
  context: BackgroundTasksContext & Pick<FrontendBackgroundTasks, "Entries">;
  entries: readonly BackgroundTaskEntry[];
  model: TaskPanelModel;
  validate(): boolean;
  visible: boolean;
}) {
  const { t } = useTranslation();
  const selection = useMemo(
    () =>
      createWindowTaskProviderSource(owner, (error) =>
        reportError("panels.tasks", "nativeProvider", error),
      ),
    [owner],
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
  usePanelReadiness("backgroundTasks.selection", !snapshot.loading && cause === undefined, cause);
  useEffect(() => selection.start(), [selection]);
  // The native invalidation may precede the coordinator's local lease commit.
  // Revalidate that commit too, without replacing the restored provider child.
  useEffect(() => selection.revalidate(), [selection, model.providerOwner, model.items]);
  const source = snapshot.source;
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
        <WindowTaskProviderScope value={{ context, entries, model, validate }}>
          <View
            pluginId={source.descriptor.view.pluginId}
            viewId={source.descriptor.view.viewId}
            visible={visible}
          />
        </WindowTaskProviderScope>
      </Boundary>
    </>
  );
}
