import { createContext, useContext, type ReactNode } from "react";
import { parentOf } from "@/lib/files/dnd";
import { usePanelWindows } from "@/store/panelWindows";
import { useSsh } from "@/store/ssh";
import { useTransfers, type TransferItem } from "@/store/transfers";
import { useWorkspace } from "@/store/workspace";
import i18n from "@/i18n/i18n";

export type TransferLocationKind = "from" | "to" | "backup" | "backupDestination" | "artifact";
export function transferLocation(item: TransferItem, kind: TransferLocationKind) {
  return kind === "backup"
    ? item.backupRecovery?.backup
    : kind === "backupDestination"
      ? item.backupRecovery?.destination
      : kind === "artifact"
        ? item.artifactRecovery
        : item[`${kind}Path`];
}
interface LocationAction {
  available: boolean;
  open: () => void | Promise<unknown>;
}
/** Per-task UI commands, not another transfer executor. A window adapter supplies
 * exact-lease, incarnation-checked coordinator commands; rendering never starts
 * or resumes a transfer. Paths are selected from the current task by a closed
 * kind, never accepted as arbitrary paths from a satellite. */
export interface TransferTaskController {
  id: string;
  pause: () => void | Promise<unknown>;
  cancel: () => void | Promise<unknown>;
  clear: () => void | Promise<unknown>;
  setSpeedLimit: (kib: number) => Promise<boolean>;
  location: (kind: TransferLocationKind) => LocationAction;
}
const Context = createContext<TransferTaskController | null>(null);
export function TransferTaskControllerScope({
  value,
  children,
}: {
  value: TransferTaskController;
  children: ReactNode;
}) {
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useTransferCommands(id: string) {
  const remote = useContext(Context);
  const satellite = usePanelWindows((s) => s.windowId !== "main");
  if (!remote && satellite) throw new Error("panel.window.unsupportedView");
  if (remote && remote.id !== id) throw new Error("panel.window.staleOwner");
  return (
    remote ?? {
      id,
      pause: () => useTransfers.getState().pause(id),
      cancel: () => useTransfers.getState().cancel(id),
      clear: () => useTransfers.getState().clear(id),
      setSpeedLimit: (kib: number) => useTransfers.getState().setSpeedLimit(id, kib),
    }
  );
}
export function useTransferLocation(
  item: TransferItem,
  kind: TransferLocationKind,
  displayedPath: string,
): LocationAction {
  const remote = useContext(Context);
  const sessions = useSsh((s) => s.sessions);
  const satellite = usePanelWindows((s) => s.windowId !== "main");
  if (!remote && satellite) throw new Error("panel.window.unsupportedView");
  if (remote) {
    if (remote.id !== item.id) throw new Error("panel.window.staleOwner");
    return remote.location(kind);
  }
  const side = kind === "from" ? "from" : "to";
  const hostId = item[`${side}HostId`],
    address = item[`${side}Address`];
  const local = hostId === null && item[`${side}Session`] === null && !address;
  const find = (live: typeof sessions) =>
    live.find((s) => s.purpose !== "forwarding" && s.hostId === hostId && s.address === address);
  const displayed = find(sessions);
  return {
    available: !!displayedPath && (local || !!displayed),
    open: () => {
      // A dead remote must never fall back to the local filesystem or another
      // session. Native-window controllers resolve their closed path kind in
      // the coordinator; this local-only fallback preserves the displayed path.
      const path = displayedPath;
      const live =
        displayed &&
        useSsh
          .getState()
          .sessions.find(
            (s) =>
              s.id === displayed.id &&
              s.hostId === hostId &&
              s.address === address &&
              s.purpose !== "forwarding",
          );
      if (!path || (!local && !live)) return;
      useWorkspace.getState().openFilePane(
        {
          source: live ? { kind: "remote", sessionId: live.id } : { kind: "local" },
          path: live ? path.slice(0, path.lastIndexOf("/")) || "/" : parentOf(path),
          ownerSessionId: live?.id ?? "local",
          remoteIdentity: live ? { hostId: live.hostId, address: live.address } : undefined,
        },
        live?.title ?? i18n.t("sftp.thisComputer"),
      );
    },
  };
}
