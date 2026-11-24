export type ProxyMissPolicy = "direct" | "remote" | "reject";
export type ProxyRouteMode = "group" | "dedicated";

export interface ProxyGroup {
  id: string;
  hostId: string;
  name: string;
  listenHost: string;
  listenPort: number;
  authMode: "none" | "password";
  authUsername: string;
  missPolicy: ProxyMissPolicy;
  autoStart: boolean;
  autoRetry: boolean;
  revision: string;
}
export interface ProxyGroupInput {
  id: string;
  hostId: string;
  name: string;
  listenHost: string;
  listenPort: number;
  authMode: "none" | "password";
  authUsername: string;
  authPassword?: string | null;
  missPolicy: ProxyMissPolicy;
  autoStart: boolean;
  autoRetry: boolean;
}
export interface ProxyRoute {
  id: string;
  groupId: string;
  name: string;
  mode: ProxyRouteMode;
  matchHost: string;
  matchPort?: number | null;
  targetHost: string;
  targetPort: number;
  bindHost?: string | null;
  bindPort?: number | null;
  revision: string;
}
export interface ProxyRuntime {
  groupId: string;
  hostId: string;
  sessionId: string;
  socksEndpoint: string;
  activeConnections: number;
  exposureWarning: boolean;
  startedAt: number;
  revision: string;
}
export interface ProxyConnection {
  id: string;
  groupId: string;
  routeId: string | null;
  source: string;
  target: string;
  bytesUp: number;
  bytesDown: number;
  startedAt: number;
  status: string;
  error: string | null;
}
