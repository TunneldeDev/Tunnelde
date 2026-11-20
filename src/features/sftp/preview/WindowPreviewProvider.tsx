import type { ComponentType } from "react";
import type { PreviewWindowData } from "./windowModel";
import {
  Component,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { translateError } from "@/lib/api/errors";
import { reportError } from "@/lib/diagnostics";
import { usePanelReadiness } from "@/lib/panels/usePanelReadiness";
import { useFactorySelection } from "@/lib/extensions/runtime/views/useFactorySelection";
import { Button } from "@/components/ui/form/Button";
import type { WindowProviderOwner } from "@/lib/panels/windowProviderSource";
import { createWindowPreviewProviderSource, WindowPreviewProviderScope } from "./windowProvider";
class Boundary extends Component<
  { children: ReactNode; failed(error: unknown): ReactNode; onFailure(error: unknown): void },
  { error: { cause: unknown } | null }
> {
  override state = { error: null as { cause: unknown } | null };
  static getDerivedStateFromError(cause: unknown) {
    return { error: { cause } };
  }
  override componentDidCatch(error: unknown) {
    reportError("panels.preview", "nativeProvider.render", error);
    this.props.onFailure(error);
  }
  override render() {
    return this.state.error ? this.props.failed(this.state.error.cause) : this.props.children;
  }
}
export function WindowPreviewProvider({
  owner,
  Body,
  data,
  validate,
  validateTarget,
  visible,
}: {
  owner: WindowProviderOwner;
  Body: ComponentType;
  data: PreviewWindowData;
  validate(): void;
  validateTarget(): void;
  visible: boolean;
}) {
  const { t } = useTranslation();
  const selection = useMemo(
    () =>
      createWindowPreviewProviderSource(owner, (error) =>
        reportError("panels.preview", "nativeProvider", error),
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
  usePanelReadiness("filePreview.selection", !snapshot.loading && cause === undefined, cause);
  useEffect(() => selection.start(), [selection]);
  // The native invalidation may precede the coordinator's local lease commit.
  // Revalidate that commit too, without replacing the restored provider child.
  useEffect(() => selection.revalidate(), [selection, data.snapshot.source.kind]);
  const source = snapshot.source;
  const failed = (error: unknown, retry = selection.refresh) => (
    <div role="alert">
      <p>{translateError(error)}</p>
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
      <Body />
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
        <WindowPreviewProviderScope value={{ Body, data, validate, validateTarget }}>
          <View
            pluginId={source.descriptor.view.pluginId}
            viewId={source.descriptor.view.viewId}
            visible={visible}
          />
        </WindowPreviewProviderScope>
      </Boundary>
    </>
  );
}
