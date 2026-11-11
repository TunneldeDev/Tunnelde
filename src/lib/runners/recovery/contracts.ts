/** Native recovery DTOs. Saved records are not proof that a process is running. */
import type { Host, SshSession } from "@/lib/api/types";
export interface RecoveryOwners {
  ids: string[];
  limited: boolean;
}
export type RecoveryConnection = "connected" | "offline" | "legacy" | "ambiguous" | "changed";
export interface RecoveryEntry {
  token: string;
  runnerId: string;
  hostId: string;
  directory: string;
  configurationPath?: string | null;
  canBrowse?: boolean;
  address: string | null;
  serverKey: string | null;
  stopPending: boolean;
  launchUncertain: boolean;
  terminalStatus: "stopped" | "failed" | "notFound" | null;
  connection: RecoveryConnection;
  controlChanged: boolean;
  canReviewDestination: boolean;
  canHandoff: boolean;
  canInspect: boolean;
  canStop: boolean;
  canForget: boolean;
  deploymentState?: "reserved" | "creating" | "uploading" | "ready" | null;
  configurationState?: "reserved" | "creating" | "writing" | "ready" | null;
}
export interface RecoverySnapshot {
  pluginId: string;
  entries: RecoveryEntry[];
  total: number;
  nextOffset: number | null;
}
export type RecoveryAction = "inspect" | "stop" | "reviewDestination" | "handoff" | "forget";
export interface RecoveryRequest {
  pluginId: string;
  token: string;
  action: RecoveryAction;
}
export interface RecoveryObservation {
  token: string;
  status: "starting" | "running" | "stopping" | "stopped" | "failed" | "notFound" | "unresponsive";
  error: string | null;
  checkedAt: number;
}
export interface RecoveryOutcome {
  accepted: boolean;
  observation: RecoveryObservation | null;
}

export interface RecoveryBrowserRequest {
  id: string;
  pluginId: string;
  token: string;
}
export interface RecoveryBrowserPlan {
  host: Host | null;
}
export interface RecoveryBrowserTarget {
  session: SshSession;
  directory: string;
  acquired: boolean;
}
