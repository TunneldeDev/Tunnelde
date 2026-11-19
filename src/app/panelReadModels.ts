import { connectionPanelModel } from "@/lib/panels/connectionModel";
import type { PanelWindowClient } from "@/lib/panels/windowClient";
import { useSsh } from "@/store/ssh";
import { useHosts } from "@/store/hosts";
import { useSettings } from "@/store/settings";
import i18n from "@/i18n/i18n";
import type { Settings } from "@/lib/api/types";

// Explicit projection, not a whole settings/hosts dump. Never transport proxy
// profiles, credentials, filesystem stores or unrelated resource state.
const appearanceKeys = [
  "theme",
  "accent",
  "colors",
  "density",
  "uiFontSize",
  "monoFontSize",
  "monoFont",
  "userCss",
  "motion",
  "titleBarStyle",
] as const;
export type WindowAppearance = Pick<Settings, (typeof appearanceKeys)[number]>;
export interface ConnectionWindowModel {
  connection: ReturnType<typeof connectionPanelModel>;
  appearance: WindowAppearance;
  language: string;
  platform: string;
}
export function startPanelReadModels(client: PanelWindowClient, failure: (error: unknown) => void) {
  let disposed = false,
    running = false,
    queued = false,
    revision = 0;
  let publisher: string | undefined;
  const publish = () => {
    if (disposed) return;
    queued = true;
    if (running) return;
    running = true;
    void (async () => {
      try {
        publisher ??= await client.control<string>({
          action: "beginModel",
          panelId: "connections",
        });
        while (queued && !disposed) {
          queued = false;
          const settings = useSettings.getState().settings;
          const model: ConnectionWindowModel = {
            connection: connectionPanelModel(),
            platform: useSettings.getState().info?.os ?? "",
            appearance: Object.fromEntries(
              appearanceKeys.map((key) => [key, settings[key]]),
            ) as WindowAppearance,
            language: i18n.resolvedLanguage ?? i18n.language,
          };
          await client.control({
            action: "publishModel",
            publisher,
            panelId: "connections",
            revision: ++revision,
            model,
          });
        }
      } catch (error) {
        if (!disposed) failure(error);
      } finally {
        running = false;
      }
    })();
  };
  const cleanups = [
    useSsh.subscribe(publish),
    useHosts.subscribe(publish),
    useSettings.subscribe(publish),
  ];
  i18n.on("languageChanged", publish);
  publish();
  return () => {
    disposed = true;
    for (const cleanup of cleanups) cleanup();
    i18n.off("languageChanged", publish);
  };
}
