import { useLayoutEffect, useState, useSyncExternalStore } from "react";
import type { PanelWindowClient } from "@/lib/panels/windowClient";
import { useWindowViews, windowViews, type WindowViewRecord } from "@/lib/panels/windowViews";
import { usePanelWindows } from "@/store/panelWindows";
import { reportError } from "@/lib/diagnostics";
import { toast } from "@/store/toasts";
import { translateError } from "@/lib/api/errors";
import type { ForwardingReadData } from "../data/readModel";
import { ForwardingReadScope } from "../data/readScope";
import { createWindowForwardingOwner } from "../runtime/windowOwner";
import { ForwardingPanelView } from "./ForwardingPanelView";
import { WindowForwardingSection } from "./WindowForwardingSection";

/** View-only production composition. NativePanelView owns surrounding capture /
 * interaction state. This does not itself admit forwarding handoff/discovery. */
export function WindowForwardingPanel({
  client,
  record,
  data,
}: {
  client: PanelWindowClient;
  record: WindowViewRecord;
  data: ForwardingReadData;
}) {
  const { binding, ready } = useWindowForwardingBinding(client, record);
  return (
    <ForwardingReadScope value={data}>
      <ForwardingPanelView
        hosts={data.hosts}
        hostsLoading={data.hostsLoading}
        sessions={data.sessions}
        rules={data.rules.entries ?? []}
        error={data.rules.error ?? data.groups.error}
        renderHost={(host) => (
          <WindowForwardingSection
            client={client}
            lease={ready?.lease}
            service={ready?.service}
            owner={binding.owner}
            host={host}
            embedded
          />
        )}
      />
    </ForwardingReadScope>
  );
}

/** Shared native owner lifecycle for forwarding and full host-detail pages. */
export function useWindowForwardingBinding(client: PanelWindowClient, record: WindowViewRecord) {
  const [binding] = useState(() => {
    const views = windowViews();
    return createWindowForwardingOwner(client, record, {
      current() {
        if (!views || windowViews() !== views || views.client !== client) return undefined;
        return useWindowViews.getState().entries.get(record.panelId);
      },
      frozen() {
        const state = usePanelWindows.getState();
        return (
          !state.available ||
          state.windowId !== client.windowId ||
          state.snapshot.transfers.some(({ offer }) => offer.lease.panelId === record.panelId) ||
          !!state.snapshot.interruptions?.some((item) => item.panelId === record.panelId)
        );
      },
      refresh() {
        const current = useWindowViews.getState().entries.get(record.panelId);
        if (!current?.lease || current.staged || current.controller !== record.controller)
          throw new Error("panel.window.staleOwner");
        void client.action(current.lease, { kind: "refreshForwarding" }).catch((error) => {
          reportError("panels.forwarding", "nativeRefresh", error);
          toast(translateError(error), "error");
        });
      },
      report: (error) => reportError("panels.forwarding", "nativeActions", error),
    });
  });
  const active = useSyncExternalStore(binding.subscribe, binding.snapshot);
  const lease = record.staged ? undefined : record.lease;
  const panelId = lease?.panelId,
    windowId = lease?.windowId,
    generation = lease?.generation;
  useLayoutEffect(
    () =>
      binding.start(
        panelId && windowId && generation !== undefined
          ? { panelId, windowId, generation }
          : undefined,
      ),
    [binding, panelId, windowId, generation],
  );
  const ready =
    active &&
    lease &&
    active.lease.panelId === lease.panelId &&
    active.lease.windowId === lease.windowId &&
    active.lease.generation === lease.generation
      ? active
      : undefined;
  return { binding, ready };
}
