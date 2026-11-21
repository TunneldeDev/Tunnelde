import type { MountEntry, MountGroup, MountRule } from "./configuration.js";
export interface MountError {
  code: string;
  message: string;
  category:
    | "authentication"
    | "trust"
    | "route"
    | "dependency"
    | "conflict"
    | "transport"
    | "cleanup"
    | "validation"
    | "internal";
  retryable: boolean;
}
export interface MountRuleStatus {
  ruleId: string;
  revision: string;
  groupId: string;
  phase: "starting" | "running" | "failed" | "stopped" | "cleanupRequired" | "needsAttention";
  runtimeId: string | null;
  sessionId: string | null;
  error: MountError | null;
  desired: boolean;
}
export interface MountConnectionStatus {
  groupId: string;
  hostId: string;
  phase: "connecting" | "connected" | "disconnected" | "retrying" | "needsAttention";
  sessionId: string | null;
  connectedAt: number | null;
  retryAt: number | null;
  error: MountError | null;
}
export interface MountSnapshot {
  hostId: string;
  revision: string;
  runtimeRevision: string;
  groups: MountEntry<MountGroup>[];
  rules: MountEntry<MountRule>[];
  connections: MountConnectionStatus[];
  ruleStates: MountRuleStatus[];
}
export interface MountOperationItem {
  targetId: string;
  phase: "pending" | "running" | "succeeded" | "failed" | "blocked" | "cancelled";
  error: MountError | null;
}
export interface MountOperation {
  id: string;
  kind: string;
  phase: "pending" | "running" | "succeeded" | "failed" | "partial" | "cancelled";
  revision: string;
  createdAt: number;
  updatedAt: number;
  items: MountOperationItem[];
}
export type MountOperationSummary = Omit<MountOperation, "items"> & {
  total: number;
  completed: number;
  failed: number;
};
