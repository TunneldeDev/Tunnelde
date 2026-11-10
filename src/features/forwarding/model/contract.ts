export interface ForwardRule {
  id: string;
  hostId: string;
  name: string;
  mode: "local" | "remote";
  bindHost: string;
  bindPort: number;
  targetHost: string;
  targetPort: number;
}
export interface ForwardInfo extends ForwardRule {
  active: boolean;
  sessionId: string | null;
  revision: string;
  runtimeId?: string | null;
}
export interface RevisionedRule extends ForwardRule {
  revision: string;
}
