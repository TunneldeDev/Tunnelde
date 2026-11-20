import { useEffect, useState } from "react";
import type { PanelWindowClient } from "./windowClient";
import type { WindowViewRecord } from "./windowViews";
import type { WindowModelAppearance } from "@/app/panelReadModels";
import { createDefaultSettings } from "@/lib/prefs/defaults";
import { applyAppearance, observeSystemAppearance } from "@/lib/prefs/appearance";
import i18n from "@/i18n/i18n";
import { toast } from "@/store/toasts";
import { translateError } from "@/lib/api/errors";
export interface NativeViewProps {
  client: PanelWindowClient;
  record: WindowViewRecord;
  presented: (model: WindowModelAppearance) => void;
}
export function useNativeReadModel<T extends WindowModelAppearance>({
  client,
  record,
  presented,
}: NativeViewProps) {
  const [model, setModel] = useState<T | null>(null);
  useEffect(() => {
    let disposed = false,
      queued = false,
      running = false;
    let unsubscribe: (() => void) | undefined;
    let settings = createDefaultSettings();
    const appearance = observeSystemAppearance(() => settings);
    const refresh = () => {
      if (disposed) return;
      queued = true;
      if (running) return;
      running = true;
      void (async () => {
        try {
          while (queued && !disposed) {
            queued = false;
            const request = record.staged
              ? { action: "stagedModel" as const, id: record.key }
              : record.lease
                ? { action: "readModel" as const, lease: record.lease }
                : null;
            if (!request) continue;
            const next = await client.control<T | null>(request);
            if (disposed || !next) continue;
            // This data originates only from the coordinator's explicit private
            // projection. Do not hydrate writable main stores in a satellite.
            settings = { ...createDefaultSettings(), ...next.appearance };
            applyAppearance(settings);
            // Native action notifications also refresh models. Re-emitting an
            // unchanged language replaces react-i18next's t function and can
            // restart feature effects (e.g. a pending host-key probe) forever.
            if ((i18n.resolvedLanguage ?? i18n.language) !== next.language)
              await i18n.changeLanguage(next.language);
            if (!disposed) setModel(next);
          }
        } catch (error) {
          if (!disposed) toast(translateError(error), "error");
        } finally {
          running = false;
        }
      })();
    };
    void client
      .subscribe(refresh)
      .then((stop) => {
        if (disposed) stop();
        else {
          unsubscribe = stop;
          refresh();
        }
      })
      .catch((error) => {
        if (!disposed) toast(translateError(error), "error");
      });
    return () => {
      disposed = true;
      unsubscribe?.();
      appearance();
    };
  }, [client, record.key, record.staged, record.lease]);
  useEffect(() => {
    if (model) presented(model);
  }, [model, presented]);
  return model;
}
