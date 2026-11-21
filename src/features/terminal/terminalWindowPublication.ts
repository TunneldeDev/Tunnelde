import { useSsh } from "@/store/ssh";
import { useWorkspace } from "@/store/workspace";
import { useSettings } from "@/store/settings";
import { usePanelWindows } from "@/store/panelWindows";
import type { SshSession } from "@/lib/api/types";
import type { PanelWindowClient } from "@/lib/panels/windowClient";
import type { WindowModelAppearance } from "@/app/panelReadModels";
import { terminalPreferenceProjection } from "./terminalViewServices";
import type { TerminalWindowModel } from "./terminalWindowModel";

/** Only main owns metadata/preferences. Keep display identity after natural PTY
 * exit, until its workspace tab is closed; never infer a fresh SSH connection. */
const sessions = new Map<string, SshSession>();
export function terminalDisplaySession(panelId: string) {
  const id = panelId.slice("terminal:".length);
  const live = useSsh.getState().sessions.find((session) => session.id === id);
  if (live) sessions.set(panelId, live);
  return live ?? sessions.get(panelId);
}
export function startTerminalWindowPublication(
  client: PanelWindowClient,
  appearance: () => WindowModelAppearance,
  failure: (error: unknown) => void,
) {
  let disposed = false,
    running = false,
    queued = false;
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
          const state = useWorkspace.getState();
          const ids = new Set(
            state.tabs.filter((tab) => tab.kind === "terminal").map((tab) => tab.id),
          );
          for (const id of [...sessions.keys()]) if (!ids.has(id)) sessions.delete(id);
          for (const id of [...publishers.keys()]) if (!ids.has(id)) publishers.delete(id);
          for (const panel of usePanelWindows.getState().snapshot.terminalViews ?? []) {
            const session = ids.has(panel.panelId) && terminalDisplaySession(panel.panelId);
            if (!session || disposed) continue;
            let publisher = publishers.get(panel.panelId);
            if (!publisher) {
              publisher = {
                id: await client.control<string>({ action: "beginModel", panelId: panel.panelId }),
                revision: 0,
              };
              publishers.set(panel.panelId, publisher);
            }
            const settings = useSettings.getState().settings;
            const model: TerminalWindowModel = {
              ...appearance(),
              terminal: {
                session: { ...session },
                closed: !useSsh.getState().sessions.some((item) => item.id === session.id),
                disconnecting: useSsh.getState().disconnectingSessionIds.includes(session.id),
                preferences: terminalPreferenceProjection(settings),
                providerSelected: !!settings.uiProviders.terminal,
              },
            };
            if (disposed) return;
            const encoded = JSON.stringify(model);
            if (publisher.encoded === encoded) continue;
            await client.control({
              action: "publishModel",
              panelId: panel.panelId,
              publisher: publisher.id,
              revision: ++publisher.revision,
              model,
            });
            publisher.encoded = encoded;
          }
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
  const stop = [
    useSsh.subscribe(refresh),
    useWorkspace.subscribe(refresh),
    useSettings.subscribe(refresh),
    usePanelWindows.subscribe(refresh),
  ];
  refresh();
  return {
    refresh,
    dispose() {
      disposed = true;
      for (const release of stop) release();
      publishers.clear();
    },
  };
}
