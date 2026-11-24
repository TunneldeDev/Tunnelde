import { createContext, useContext, useSyncExternalStore, type ReactNode } from "react";
import type { HostPanelData } from "./projection";
import type { HostPanelCommand, HostPanelTarget } from "./protocol";
import { hostPanelSource } from "./source";
import { executeHostPanelCommand } from "./execute";
import { usePanelLeaseAction } from "@/lib/panels/interaction";
import { notifyError } from "@/lib/api/errors";

const Context = createContext<{ data: HostPanelData; requireRemote: boolean } | null>(null);
export function HostPanelScope({
  data,
  children,
  requireRemote = false,
}: {
  data: HostPanelData;
  children: ReactNode;
  requireRemote?: boolean;
}) {
  return <Context.Provider value={{ data, requireRemote }}>{children}</Context.Provider>;
}
const idleSubscribe = () => () => {};
const emptySnapshot = () => null;
const subscribeLocal = (notify: () => void) => hostPanelSource.subscribe(notify);
export function useHostPanel() {
  const remote = useContext(Context);
  const local = useSyncExternalStore(
    remote ? idleSubscribe : subscribeLocal,
    remote ? emptySnapshot : hostPanelSource.snapshot,
  );
  const data = remote?.data ?? local!;
  const action = usePanelLeaseAction();
  const run = async (command: HostPanelCommand): Promise<boolean> => {
    try {
      const result = action({ kind: "hosts", command });
      if (remote?.requireRemote && !result) throw new Error("panel.window.staleOwner");
      return (await (result ?? executeHostPanelCommand(command))) !== false;
    } catch (error) {
      notifyError(error, { domain: "hosts.panel", operation: command.operation });
      return false;
    }
  };
  const hostTarget = (id: string): HostPanelTarget => data.hostTargets[id]!;
  const groupTarget = (id: string | null): HostPanelTarget | null =>
    id ? data.groupTargets[id]! : null;
  return { data, run, hostTarget, groupTarget, remoteActions: remote?.requireRemote ?? false };
}
