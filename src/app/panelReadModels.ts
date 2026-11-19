import { useTaskProjection } from "@/lib/panels/taskProjection";
import type { TaskViewEntry } from "@/lib/panels/taskProjection";
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
export interface WindowModelAppearance {
  appearance: WindowAppearance;
  language: string;
  platform: string;
}
export interface TaskWindowModel extends WindowModelAppearance {
  tasks: readonly TaskViewEntry[];
}
export interface ConnectionWindowModel extends WindowModelAppearance {
  connection: ReturnType<typeof connectionPanelModel>;
}
export function startPanelReadModels(client: PanelWindowClient, failure: (error: unknown) => void) {
  let disposed = false;
  const publishers = new Map<
    string,
    { publisher?: string; revision: number; running: boolean; queued: boolean }
  >();
  const appearance = (): WindowModelAppearance => {
    const settings = useSettings.getState().settings;
    return {
      platform: useSettings.getState().info?.os ?? "",
      language: i18n.resolvedLanguage ?? i18n.language,
      appearance: Object.fromEntries(
        appearanceKeys.map((key) => [key, settings[key]]),
      ) as WindowAppearance,
    };
  };
  const publish = (panelId: "connections" | "tasks") => {
    if (disposed) return;
    let state = publishers.get(panelId);
    if (!state) {
      state = { revision: 0, running: false, queued: false };
      publishers.set(panelId, state);
    }
    const current = state;
    current.queued = true;
    if (current.running) return;
    current.running = true;
    void (async () => {
      try {
        current.publisher ??= await client.control<string>({ action: "beginModel", panelId });
        while (current.queued && !disposed) {
          current.queued = false;
          const model =
            panelId === "connections"
              ? { ...appearance(), connection: connectionPanelModel() }
              : { ...appearance(), tasks: useTaskProjection.getState().items };
          await client.control({
            action: "publishModel",
            publisher: current.publisher,
            panelId,
            revision: ++current.revision,
            model,
          });
        }
      } catch (error) {
        if (!disposed) failure(error);
      } finally {
        current.running = false;
      }
    })();
  };
  const connections = () => publish("connections"),
    tasks = () => publish("tasks"),
    both = () => {
      connections();
      tasks();
    };
  const cleanups = [
    useSsh.subscribe(connections),
    useHosts.subscribe(connections),
    useSettings.subscribe(both),
    useTaskProjection.subscribe(tasks),
  ];
  i18n.on("languageChanged", both);
  both();
  return () => {
    disposed = true;
    for (const cleanup of cleanups) cleanup();
    i18n.off("languageChanged", both);
  };
}
