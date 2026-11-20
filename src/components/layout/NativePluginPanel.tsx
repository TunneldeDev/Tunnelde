import { useState } from "react";
import { useTranslation } from "react-i18next";
import { createFrontendFactoryComponent } from "@/lib/extensions/runtime/views/factory";
import { openScopedFrontendView } from "@/lib/extensions/runtime/views/frontend";
import { createResourceScope, ResourceScopeClosed } from "@/lib/extensions/resourceScope";
import { useWindowViews, windowViews, type WindowViewRecord } from "@/lib/panels/windowViews";
import { reportError } from "@/lib/diagnostics";

function ScopedPluginPanel({ record, visible }: { record: WindowViewRecord; visible: boolean }) {
  const descriptor = record.plugin!;
  // The record object changes on commit, but its key/controller/descriptor do
  // not. Keep the exact staged tree and scoped attachment through promotion.
  const [View] = useState(() =>
    createFrontendFactoryComponent(async (signal, state) => {
      const report = (error: unknown) =>
        reportError(`plugins.${descriptor.pluginId}.nativeView`, "view", error);
      const views = windowViews();
      const check = () => {
        const current = useWindowViews.getState().entries.get(record.panelId);
        if (
          !views ||
          windowViews() !== views ||
          current?.controller !== record.controller ||
          current.plugin?.revision !== descriptor.revision ||
          signal.aborted
        )
          throw new ResourceScopeClosed();
      };
      check();
      const client = views!.client.pluginViews(report);
      const parent = createResourceScope({ parent: signal, report });
      try {
        const mounted = await openScopedFrontendView({
          owner: descriptor,
          viewId: descriptor.viewId,
          parent,
          transport: client.transport,
          openView: () =>
            client.open(
              record.staged
                ? { kind: "staged", id: record.key }
                : { kind: "owned", lease: record.lease! },
              descriptor.pluginId,
              descriptor.runtimeId,
              descriptor.viewId,
            ),
          check,
          state,
          signal,
        });
        return { ...mounted, dispose: () => parent.dispose() };
      } catch (error) {
        parent.dispose();
        throw error;
      }
    }),
  );
  return <View pluginId={descriptor.pluginId} viewId={descriptor.viewId} visible={visible} />;
}

/** Same ordinary-plugin renderer in both documents. No singleton activation,
 * plugin store hydration or provider handle imitation occurs in this component.
 * NativePanelView supplies the surrounding capture/interaction controller. */
export function NativePluginPanel({
  panelId,
  visible = true,
}: {
  panelId: string;
  visible?: boolean;
}) {
  const { t } = useTranslation();
  const record = useWindowViews((state) => state.entries.get(panelId));
  if (!record?.plugin) return <p role="status">{t("common.loading")}</p>;
  return <ScopedPluginPanel key={record.key} record={record} visible={visible} />;
}
