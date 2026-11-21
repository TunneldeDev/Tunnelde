import { useEditors, editorDocument } from "@/store/editors";
import { useWorkspace } from "@/store/workspace";
import { useSettings } from "@/store/settings";
import { useSsh } from "@/store/ssh";
import { usePlugins } from "@/store/plugins";
import { usePanelWindows } from "@/store/panelWindows";
import { useEditorLocation } from "@/store/editorLocation";
import { documentFormatters, useFormatting } from "@/lib/plugins/formatting";
import { editorShortcutCommands } from "./mainEditorPageServices";
import { useEditorWindowRegistrations } from "./editorWindowRegistration";
import type { EditorWindowModel } from "./editorWindowModel";
import type { PanelWindowClient } from "@/lib/panels/windowClient";
import type { WindowModelAppearance } from "@/app/panelReadModels";
export function startEditorWindowPublication(
  client: PanelWindowClient,
  appearance: () => WindowModelAppearance,
  failure: (error: unknown) => void,
) {
  let disposed = false,
    running = false,
    queued = false;
  const publishers = new Map<string, { id: string; revision: number; encoded?: string }>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const refresh = () => {
    if (disposed) return;
    clearTimeout(timer);
    timer = setTimeout(run, 40);
  };
  const run = () => {
    if (disposed) return;
    queued = true;
    if (running) return;
    running = true;
    void (async () => {
      try {
        while (queued && !disposed) {
          queued = false;
          for (const [tabId, id] of useEditorWindowRegistrations.getState().entries) {
            if (!usePanelWindows.getState().snapshot.editorPages?.some((p) => p.panelId === id))
              continue;
            const tab = useWorkspace
              .getState()
              .tabs.find((t) => t.id === tabId && t.kind === "editor");
            if (!tab) continue;
            editorDocument(tabId); // upgrade old in-memory entries only; never re-read file
            const entry = useEditors.getState().entries[tabId];
            const hostId = tab.hostId ?? entry?.recoveryTarget?.hostId;
            const candidate = useSsh
              .getState()
              .sessions.find(
                (s) =>
                  s.hostId === hostId &&
                  s.purpose !== "forwarding" &&
                  (!entry?.recoveryTarget || s.address === entry.recoveryTarget.address),
              );
            const settings = useSettings.getState().settings,
              plugins = usePlugins.getState().items;
            const model: EditorWindowModel = {
              ...appearance(),
              tabId,
              editor: {
                entry,
                candidate,
                preferences: {
                  wordWrap: settings.editorWordWrap,
                  tabSize: settings.editorTabSize,
                  spellCheck: settings.editorSpellCheck,
                },
                formatting: useFormatting.getState().busy.includes(tabId),
                hasFormatter: !!entry && documentFormatters(entry.path, plugins).length > 0,
                commands: editorShortcutCommands(entry?.path ?? "", plugins),
                location: useEditorLocation.getState().target,
              },
            };
            let publisher = publishers.get(id);
            if (!publisher) {
              publisher = {
                id: await client.control<string>({ action: "beginModel", panelId: id }),
                revision: 0,
              };
              publishers.set(id, publisher);
            }
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
            if (![...useEditorWindowRegistrations.getState().entries.values()].includes(id))
              publishers.delete(id);
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
    useEditors.subscribe(refresh),
    useWorkspace.subscribe(refresh),
    useSettings.subscribe(refresh),
    useSsh.subscribe(refresh),
    usePlugins.subscribe(refresh),
    useFormatting.subscribe(refresh),
    useEditorLocation.subscribe(refresh),
    usePanelWindows.subscribe(refresh),
    useEditorWindowRegistrations.subscribe(refresh),
  ];
  refresh();
  return {
    refresh,
    dispose() {
      disposed = true;
      clearTimeout(timer);
      stops.forEach((s) => s());
      publishers.clear();
    },
  };
}
