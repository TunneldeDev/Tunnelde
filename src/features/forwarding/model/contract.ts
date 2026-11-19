export interface ForwardAutomation {
  autoStart: boolean;
  autoRetry: boolean;
}
export interface ForwardGroup {
  id: string;
  hostId: string;
  name: string;
  revision: string;
}
export interface ForwardRule {
  groupId?: string | null;
  id: string;
  hostId: string;
  name: string;
  mode: "local" | "remote";
  bindHost: string;
  bindPort: number;
  targetHost: string;
  targetPort: number;
  automation?: ForwardAutomation;
}
export interface ForwardInfo extends ForwardRule {
  active: boolean;
  sessionId: string | null;
  revision: string;
  runtimeId?: string | null;
  automationStatus?: {
    phase: "idle" | "starting" | "running" | "retrying" | "paused" | "needsAttention";
    retryAt: number | null;
    error: unknown;
  };
}
export interface RevisionedRule extends ForwardRule {
  revision: string;
}
