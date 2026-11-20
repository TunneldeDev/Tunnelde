import { useLayoutEffect, useState } from "react";
import type { PanelWindowClient } from "@/lib/panels/windowClient";
import { createWindowProviderOwner } from "@/lib/panels/windowProviderOwner";
import { useWindowViews, windowViews, type WindowViewRecord } from "@/lib/panels/windowViews";
import { usePanelWindows } from "@/store/panelWindows";
import { HostTree } from "@/components/layout/HostTree";
import { HostPanelScope } from "./context";
import type { HostPanelData } from "./projection";
import { WindowHostProvider } from "./WindowHostProvider";
export function WindowHostsPanel({
  client,
  record,
  data,
}: {
  client: PanelWindowClient;
  record: WindowViewRecord;
  data: HostPanelData;
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
          !!state.snapshot.interruptions?.some((i) => i.panelId === record.panelId)
        );
      },
    });
  });
  const lease = record.staged ? undefined : record.lease;
  useLayoutEffect(() => binding.start(lease), [binding, lease]);
  return (
    <HostPanelScope data={data} requireRemote>
      <WindowHostProvider owner={binding.owner} visible={!record.staged}>
        <HostTree />
      </WindowHostProvider>
    </HostPanelScope>
  );
}
