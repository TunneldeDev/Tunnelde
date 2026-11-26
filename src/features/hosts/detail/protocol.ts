import type { HostPanelTarget } from "../panel/protocol";
export type HostDetailOperation =
  "connect" | "monitor" | "sftp" | "favorite" | "edit" | "delete" | "duplicate";
export interface HostDetailCommand {
  operation: HostDetailOperation;
  host: HostPanelTarget;
}
