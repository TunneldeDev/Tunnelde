/** Public experimental UI SDK 0.1.0 contract. */
export interface FrontendForwardingEntry {
  id: string;
  hostId: string;
  name: string;
  mode: "local" | "remote";
  bindHost: string;
  bindPort: number;
  targetHost: string;
  targetPort: number;
  /** Opaque persisted rule version, including changes back to identical values. */
  revision: string;
  active: boolean;
  /** Opaque live instance identity; changes on every successful start. */
  runtimeId: string | null;
}
