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
const Context = createContext<
  (ConnectionPanelModel & { disconnect: (id: string) => Promise<void> }) | null
>(null);
export function ConnectionModelScope({
  model,
  disconnect,
  children,
}: {
  model: ConnectionPanelModel;
  disconnect: (id: string) => Promise<void>;
  children: ReactNode;
}) {
  return <Context.Provider value={{ ...model, disconnect }}>{children}</Context.Provider>;
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
  return remote ?? { sessions, history, hosts, disconnectingSessionIds, disconnect };
}
