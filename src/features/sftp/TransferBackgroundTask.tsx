import { useState } from "react";
import { ConnectDialog } from "@/features/connect/ConnectDialog";
import type { TaskViewProps } from "@/features/tasks/presentation";
import { useHosts } from "@/store/hosts";
import { useSsh } from "@/store/ssh";
import { useTransfers, type TransferItem } from "@/store/transfers";
import { TransferTask } from "./TransferTask";

/** Transfer-only recovery and detail controls stay owned by the transfer feature. */
export function TransferBackgroundTask({ task, now }: TaskViewProps) {
  const item = useTransfers((state) => state.items.find((item) => item.id === task.id));
  const hosts = useHosts((state) => state.hosts);
  const [connecting, setConnecting] = useState<string | null>(null);
  const resume = (current: TransferItem) => {
    // Unknown receipts need no network probe; explicit rejections perform no
    // filesystem I/O. Only a confirmed creation can require reconnecting.
    if (current.retainedCreation && current.retainedSettlement !== "created") {
      void useTransfers.getState().clear(current.id);
      return;
    }
    const endpoints = [
      ...(current.status === "cleanupPending"
        ? []
        : [{ id: current.fromHostId, address: current.fromAddress }]),
      { id: current.toHostId, address: current.toAddress },
    ];
    const missing = endpoints.find(
      ({ id, address }) =>
        id &&
        !useSsh
          .getState()
          .sessions.some(
            (session) => session.hostId === id && (!address || session.address === address),
          ),
    );
    if (missing?.id && hosts.some((host) => host.id === missing.id)) setConnecting(missing.id);
    else if (current.status === "cleanupPending") void useTransfers.getState().clear(current.id);
    else void useTransfers.getState().resume(current.id);
  };
  const host = hosts.find((host) => host.id === connecting);
  if (!item) return null;
  return (
    <>
      <TransferTask item={item} now={now} onResume={() => resume(item)} />
      {host ? (
        <ConnectDialog
          key={host.id}
          host={host}
          onClose={() => setConnecting(null)}
          onConnected={() => {
            setConnecting(null);
            const current = useTransfers.getState().items.find((item) => item.id === task.id);
            if (current?.status === "cleanupPending") void useTransfers.getState().hydrate();
            else if (current) queueMicrotask(() => resume(current));
          }}
        />
      ) : null}
    </>
  );
}
