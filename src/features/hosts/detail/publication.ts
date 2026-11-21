import { useWorkspace } from "@/store/workspace";
import { useHosts } from "@/store/hosts";
import { useSettings } from "@/store/settings";
import { usePlugins } from "@/store/plugins";
import { usePanelWindows } from "@/store/panelWindows";
import { hostPanelSource } from "../panel/source";
import { createForwardingReadSource } from "@/features/forwarding/data/readSource";
import { hostDetailTabId, hostDetailAllowsMove, useHostDetailRegistrations } from "./registration";
import type { HostDetailModel } from "./model";
import type { PanelWindowClient } from "@/lib/panels/windowClient";
import type { WindowModelAppearance } from "@/app/panelReadModels";
export function startHostDetailPublication(
  client: PanelWindowClient,
  appearance: () => WindowModelAppearance,
  failure: (e: unknown) => void,
) {
  let disposed = false,
    running = false,
    queued = false,
    release: (() => void) | undefined;
  const forwarding = createForwardingReadSource();
  const publishers = new Map<string, { id: string; revision: number; encoded?: string }>();
  const refresh = () => {
    if (disposed) return;
    const needed = useHostDetailRegistrations.getState().entries.size > 0;
    if (needed && !release) {
      release = () => {};
      release = forwarding.retain();
    } else if (!needed && release) {
      release();
      release = undefined;
    }
    queued = true;
    if (running) return;
    running = true;
    void (async () => {
      try {
        while (queued && !disposed) {
          queued = false;
          for (const [tabId, id] of useHostDetailRegistrations.getState().entries) {
            const tab = useWorkspace
              .getState()
              .tabs.find((t) => t.id === tabId && t.kind === "host");
            if (
              !tab ||
              !usePanelWindows.getState().snapshot.hostPages?.some((v) => v.panelId === id)
            )
              continue;
            let publisher = publishers.get(id);
            if (!publisher) {
              publisher = {
                id: await client.control<string>({ action: "beginModel", panelId: id }),
                revision: 0,
              };
              publishers.set(id, publisher);
            }
            const data = hostPanelSource.snapshot(),
              host = data.hosts.find((h) => h.id === tab.hostId) ?? null;
            const f = forwarding.snapshot();
            const model: HostDetailModel = {
              ...appearance(),
              detail: {
                host,
                target: host ? (data.hostTargets[host.id] ?? null) : null,
                groupName: data.groups.find((g) => g.id === host?.groupId)?.name,
                hostCount: data.hosts.length,
                allowMove: hostDetailAllowsMove(tab.hostId ?? ""),
                forwarding: {
                  ...f,
                  hosts: f.hosts.filter((h) => h.id === tab.hostId),
                  sessions: f.sessions.filter((s) => s.hostId === tab.hostId),
                  rules: {
                    ...f.rules,
                    entries: f.rules.entries?.filter((r) => r.hostId === tab.hostId) ?? null,
                  },
                  groups: {
                    ...f.groups,
                    entries: f.groups.entries?.filter((g) => g.hostId === tab.hostId) ?? null,
                  },
                },
              },
            };
            const encoded = JSON.stringify(model);
            if (disposed || publisher.encoded === encoded) continue;
            await client.control({
              action: "publishModel",
              panelId: id,
              publisher: publisher.id,
              revision: ++publisher.revision,
              model,
            });
            publisher.encoded = encoded;
          }
          for (const id of publishers.keys()) if (!hostDetailTabId(id)) publishers.delete(id);
        }
      } catch (e) {
        publishers.clear();
        if (!disposed) failure(e);
      } finally {
        running = false;
        if (queued && !disposed) refresh();
      }
    })();
  };
  const stops = [
    useWorkspace.subscribe(refresh),
    useHosts.subscribe(refresh),
    useSettings.subscribe(refresh),
    usePlugins.subscribe(refresh),
    usePanelWindows.subscribe(refresh),
    useHostDetailRegistrations.subscribe(refresh),
    forwarding.store.subscribe(refresh),
  ];
  refresh();
  return {
    refresh,
    dispose() {
      disposed = true;
      for (const stop of stops) stop();
      release?.();
      forwarding.dispose();
      publishers.clear();
    },
  };
}
