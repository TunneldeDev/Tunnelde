import type { HostPanelTarget } from "../panel/protocol";
export type HostDetailOperation = "connect" | "sftp" | "favorite" | "edit" | "delete" | "duplicate";
export interface HostDetailCommand {
  operation: HostDetailOperation;
  host: HostPanelTarget;
}
