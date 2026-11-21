import { disconnectConnectionBatch } from "@/lib/session/connectionBatch";
import { usePanelWindows } from "@/store/panelWindows";
import { windowViews } from "./windowViews";
import { toast } from "@/store/toasts";
import { translateError } from "@/lib/api/errors";
import { createContext, useContext, type ReactNode } from "react";
import { useSsh } from "@/store/ssh";
import { useHosts } from "@/store/hosts";
import type { SshSession } from "@/lib/api/types";
import type { SessionHistory } from "@/store/sshHistory";

export interface ConnectionPanelModel {
  version: 1;
  sessions: SshSession[];
  history: SessionHistory[];
  hosts: { id: string; name: string }[];
  disconnectingSessionIds: string[];
}
type DisconnectMany = (ids: readonly string[]) => Promise<{ closed: string[]; failed: string[] }>;
const Context = createContext<
  | (ConnectionPanelModel & {
      disconnect: (id: string) => Promise<void>;
      disconnectMany: DisconnectMany;
    })
  | null
>(null);
export function ConnectionModelScope({
  model,
  disconnect,
  disconnectMany,
  children,
}: {
  model: ConnectionPanelModel;
  disconnect: (id: string) => Promise<void>;
  disconnectMany: DisconnectMany;
  children: ReactNode;
}) {
  return (
    <Context.Provider value={{ ...model, disconnect, disconnectMany }}>{children}</Context.Provider>
  );
}
export function connectionPanelModel(): ConnectionPanelModel {
  const { sessions, history, disconnectingSessionIds } = useSsh.getState();
  return {
    version: 1,
    sessions,
    history,
    disconnectingSessionIds,
    // Never serialize full hosts: they contain credential references/settings.
    hosts: useHosts.getState().hosts.map(({ id, name }) => ({ id, name })),
  };
}
export function useConnectionPanelModel() {
  const remote = useContext(Context);
  const sessions = useSsh((s) => s.sessions);
  const history = useSsh((s) => s.history);
  const disconnectingSessionIds = useSsh((s) => s.disconnectingSessionIds);
  const disconnect = useSsh((s) => s.disconnect);
  const hosts = useHosts((s) => s.hosts);
  return (
    remote ?? {
      sessions,
      history,
      hosts,
      disconnectingSessionIds,
      disconnectMany: async (ids: readonly string[]) => {
        if (!usePanelWindows.getState().available) return useSsh.getState().disconnectMany(ids);
        const client = windowViews()?.client;
        const state = usePanelWindows.getState();
        // Bind the WHOLE confirmed batch to one lease; a late model refresh or
        // owner change must not let queued workers retarget another generation.
        const lease = state.snapshot.panels.find(
          (panel) => panel.panelId === "connections" && panel.windowId === state.windowId,
        );
        return disconnectConnectionBatch(ids, async (id) => {
          try {
            if (!client || !lease) throw new Error("panel.window.staleOwner");
            await client.action(lease, { kind: "disconnect", sessionId: id });
          } catch (error) {
            toast(translateError(error), "error");
            throw error;
          }
        });
      },
      disconnect: async (id: string) => {
        const state = usePanelWindows.getState(),
          client = windowViews()?.client;
        const lease = state.snapshot.panels.find(
          (panel) => panel.panelId === "connections" && panel.windowId === state.windowId,
        );
        if (!state.available) return disconnect(id);
        try {
          if (!client || !lease) throw new Error("panel.window.staleOwner");
          await client.action(lease, { kind: "disconnect", sessionId: id });
        } catch (error) {
          toast(translateError(error), "error");
        }
      },
    }
  );
}
