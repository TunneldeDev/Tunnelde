import type { TransferItem } from "@/store/transfers";
import type { SshSession } from "@/lib/api/types";

export type TransferLocationKind = "from" | "to" | "backup" | "backupDestination" | "artifact";
export const transferLocationKinds: TransferLocationKind[] = [
  "from",
  "to",
  "backup",
  "backupDestination",
  "artifact",
];
export function transferLocation(item: TransferItem, kind: TransferLocationKind) {
  return kind === "backup"
    ? item.backupRecovery?.backup
    : kind === "backupDestination"
      ? item.backupRecovery?.destination
      : kind === "artifact"
        ? item.artifactRecovery
        : item[`${kind}Path`];
}
/** Exact endpoint identity; a forwarding-only session never provides an SFTP
 * endpoint. An incomplete/unknown remote endpoint is never this computer. */
export function transferEndpoint(
  item: TransferItem,
  side: "from" | "to",
  sessions: readonly SshSession[],
) {
  const hostId = item[`${side}HostId`],
    address = item[`${side}Address`];
  const local = hostId === null && item[`${side}Session`] === null && !address;
  const session = sessions.find(
    (s) => s.purpose !== "forwarding" && s.hostId === hostId && s.address === address,
  );
  return { local, session, hostId, address };
}
export interface TransferViewData {
  item: TransferItem;
  inspect: TransferLocationKind[];
}
/** Explicit display projection, not a store clone. Session handles, credentials
 * and extra future fields must not leak into read models or layout capsules. */
export function transferView(
  item: TransferItem,
  sessions: readonly SshSession[],
): TransferViewData {
  const {
    id,
    pluginId,
    phase,
    direction,
    name,
    transferred,
    total,
    status,
    error,
    durable,
    retainedCreation,
    retainedSettlement,
    updatedAt,
    cancelling,
    pausing,
    clearing,
    rate,
    speedLimitKib,
    fromAddress,
    toAddress,
    fromPath,
    toPath,
    backupRecovery,
    artifactRecovery,
  } = item;
  return {
    item: {
      id,
      pluginId,
      phase,
      direction,
      name,
      transferred,
      total,
      status,
      error,
      durable,
      retainedCreation,
      retainedSettlement,
      updatedAt,
      cancelling,
      pausing,
      clearing,
      rate: rate
        ? { baseline: rate.baseline, samples: rate.samples.map(({ at, bytes }) => ({ at, bytes })) }
        : undefined,
      speedLimitKib,
      fromAddress,
      toAddress,
      fromPath,
      toPath,
      backupRecovery: backupRecovery
        ? { backup: backupRecovery.backup, destination: backupRecovery.destination }
        : backupRecovery,
      artifactRecovery,
    },
    inspect: transferLocationKinds.filter((kind) => {
      const endpoint = transferEndpoint(item, kind === "from" ? "from" : "to", sessions);
      return !!transferLocation(item, kind) && (endpoint.local || !!endpoint.session);
    }),
  };
}
/** Progress/status updates keep a ticket. Retargeting a task does not. */
export const transferBinding = (item: TransferItem) =>
  JSON.stringify([
    item.id,
    item.pluginId,
    item.durable,
    item.retainedCreation,
    item.fromHostId,
    item.fromAddress,
    item.fromSession,
    item.fromPath,
    item.toHostId,
    item.toAddress,
    item.toSession,
    item.toPath,
  ]);
