import { useTranslation } from "react-i18next";
import { usePanelReadiness } from "@/lib/panels/usePanelReadiness";
import { usePreviewPublication } from "./windowPublication";
import { useLayoutEffect, useState } from "react";
import { createWindowProviderOwner } from "@/lib/panels/windowProviderOwner";
import { usePanelWindows } from "@/store/panelWindows";
import { useWindowViews, windowViews, type WindowViewRecord } from "@/lib/panels/windowViews";
import type { PanelWindowClient } from "@/lib/panels/windowClient";
import type { PreviewWindowData } from "./windowModel";
import { WindowPreview } from "./WindowPreview";

/** Shared main/satellite composition, mounted BELOW NativePanelView rather than
 * in a sibling persistent portal. No lost capture/interaction React context. */
export function NativePreviewContent({
  client,
  record,
  data,
  mainUrl,
}: {
  client: PanelWindowClient;
  record: WindowViewRecord;
  data: PreviewWindowData;
  mainUrl?: string;
}) {
  const { t } = useTranslation();
  const publishedAttempt = usePreviewPublication((state) => state.attemptId);
  const ready = client.windowId !== "main" || publishedAttempt === data.snapshot.attemptId;
  usePanelReadiness("preview.publication", ready);
  if (!ready) return <p role="status">{t("common.loading")}</p>;
  return <Content key={record.key} client={client} record={record} data={data} mainUrl={mainUrl} />;
}
function Content({
  client,
  record,
  data,
  mainUrl,
}: {
  client: PanelWindowClient;
  record: WindowViewRecord;
  data: PreviewWindowData;
  mainUrl?: string;
}) {
  const [binding] = useState(() => {
    const views = windowViews();
    return createWindowProviderOwner(client, record, {
      current: () =>
        windowViews() === views ? useWindowViews.getState().entries.get(record.panelId) : undefined,
      frozen: () => {
        const state = usePanelWindows.getState();
        return (
          !state.available ||
          state.windowId !== client.windowId ||
          state.snapshot.transfers.some(({ offer }) => offer.lease.panelId === record.panelId) ||
          !!state.snapshot.interruptions?.some((item) => item.panelId === record.panelId)
        );
      },
    });
  });
  const frozen = usePanelWindows(
    (state) =>
      state.snapshot.transfers.some(({ offer }) => offer.lease.panelId === record.panelId) ||
      !!state.snapshot.interruptions?.some((item) => item.panelId === record.panelId),
  );
  const lease = record.staged ? undefined : record.lease;
  useLayoutEffect(() => binding.start(lease), [binding, lease]);
  const active = !record.staged && !record.moving && !frozen && !!lease;
  return <WindowPreview owner={binding.owner} data={data} active={active} mainUrl={mainUrl} />;
}
