import type { PanelWindowClient } from "@/lib/panels/windowClient";
import type { WindowModelAppearance } from "@/app/panelReadModels";
import type { SettingsWindowModel } from "./model";
import { useSettingsOwner } from "./mainBinding";
import { useSettingsRegistrations } from "./registration";
import { usePanelWindows } from "@/store/panelWindows";
export function startSettingsWindowPublication(
  client: PanelWindowClient,
  appearance: () => WindowModelAppearance,
  failure: (error: unknown) => void,
) {
  let disposed = false,
    queued = false,
    running = false;
  const publishers = new Map<string, { id: string; revision: number; encoded?: string }>();
  const refresh = () => {
    if (disposed) return;
    queued = true;
    if (running) return;
    running = true;
    void (async () => {
      try {
        while (queued && !disposed) {
          queued = false;
          const projection = useSettingsOwner.getState().projection;
          if (!projection) continue;
          for (const id of useSettingsRegistrations.getState().entries.values()) {
            if (!usePanelWindows.getState().snapshot.settingsPages?.some((v) => v.panelId === id))
              continue;
            let publisher = publishers.get(id);
            if (!publisher) {
              publisher = {
                id: await client.control<string>({ action: "beginModel", panelId: id }),
                revision: 0,
              };
              publishers.set(id, publisher);
            }
            const model: SettingsWindowModel = { ...appearance(), settings: projection };
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
          for (const id of publishers.keys())
            if (![...useSettingsRegistrations.getState().entries.values()].includes(id))
              publishers.delete(id);
        }
      } catch (error) {
        publishers.clear();
        if (!disposed) failure(error);
      } finally {
        running = false;
        if (queued && !disposed) refresh();
      }
    })();
  };
  const stops = [
    useSettingsOwner.subscribe(refresh),
    useSettingsRegistrations.subscribe(refresh),
    usePanelWindows.subscribe(refresh),
  ];
  refresh();
  return {
    refresh,
    dispose() {
      disposed = true;
      for (const stop of stops) stop();
      publishers.clear();
    },
  };
}
