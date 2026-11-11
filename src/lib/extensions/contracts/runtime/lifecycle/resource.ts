/** Experimental host-owned runtime lifecycle DTOs, separate from UI ResourceScope. */
export type RuntimeResourceKind = "connection" | "forward" | "mount" | "task" | "transfer";
export type RuntimeResourceState = "owned" | "releaseRequested" | "cleanupRequired";
export interface RuntimeResource {
  /** Opaque identifier bound to plugin fingerprint, runtime generation and exact domain instance. */
  handle: string;
  kind: RuntimeResourceKind;
  state: RuntimeResourceState;
}
