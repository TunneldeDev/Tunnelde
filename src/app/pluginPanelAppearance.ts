import type { PanelWindowClient } from "@/lib/panels/windowClient";
import { usePanelWindows } from "@/store/panelWindows";
import { useSettings } from "@/store/settings";
import i18n from "@/i18n/i18n";
import type { WindowModelAppearance } from "./panelReadModels";

/** Appearance only: no plugin/store/settings dump, activation secret or domain
 * state. Factories query their own data through the exact native attachment. */
export function startPluginPanelAppearance(
  client: PanelWindowClient,
  appearance: () => WindowModelAppearance,
  failure: (error: unknown) => void,
) {
  let disposed = false;
  const entries = new Map<
    string,
    { revision: string; publisher?: string; serial: number; running: boolean; queued: boolean }
  >();
  const current = (id: string, entry: { revision: string }) => {
    if (disposed || entries.get(id) !== entry) return false;
    const snapshot = usePanelWindows.getState().snapshot;
    return [...(snapshot.pluginViews ?? []), ...(snapshot.declarativeViews ?? [])].some(
      (view) => view.panelId === id && view.revision === entry.revision,
    );
  };
  const publish = (id: string) => {
    const entry = entries.get(id);
    if (!entry) return;
    entry.queued = true;
    if (entry.running) return;
    entry.running = true;
    void (async () => {
      try {
        entry.publisher ??= await client.control<string>({
          action: "beginPluginModel",
          panelId: id,
          revision: entry.revision,
        });
        while (entry.queued && current(id, entry)) {
          entry.queued = false;
          await client.control({
            action: "publishModel",
            panelId: id,
            publisher: entry.publisher,
            revision: ++entry.serial,
            model: appearance(),
          });
        }
      } catch (error) {
        if (current(id, entry)) failure(error);
      } finally {
        entry.running = false;
      }
    })();
  };
  const reconcile = () => {
    const snapshot = usePanelWindows.getState().snapshot;
    const views = [...(snapshot.pluginViews ?? []), ...(snapshot.declarativeViews ?? [])];
    for (const [id, entry] of entries)
      if (!views.some((view) => view.panelId === id && view.revision === entry.revision))
        entries.delete(id);
    for (const view of views) {
      if (entries.has(view.panelId)) continue;
      entries.set(view.panelId, {
        revision: view.revision,
        serial: 0,
        running: false,
        queued: false,
      });
      publish(view.panelId);
    }
  };
  const refresh = () => {
    for (const id of entries.keys()) publish(id);
  };
  const stopWindows = usePanelWindows.subscribe(reconcile);
  const stopSettings = useSettings.subscribe(refresh);
  i18n.on("languageChanged", refresh);
  reconcile();
  return () => {
    disposed = true;
    stopWindows();
    stopSettings();
    i18n.off("languageChanged", refresh);
    entries.clear();
  };
}
