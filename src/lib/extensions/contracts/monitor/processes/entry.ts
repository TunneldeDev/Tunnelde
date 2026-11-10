/** Public experimental UI SDK 0.1.0 process projection. Unknown metrics are null. */
export interface FrontendProcessEntry {
  /** Opaque within one revision. Never use as a PID or across snapshots. */
  key: string;
  pid: number;
  name: string;
  userName: string | null;
  groupName: string | null;
  uid: number | null;
  gid: number | null;
  parentPid: number | null;
  threads: number | null;
  state: string | null;
  cpuTotal: number | null;
  cpuPerCore: number | null;
  rss: number | null;
  diskReadRate: number | null;
  diskWriteRate: number | null;
  networkRxRate: number | null;
  networkTxRate: number | null;
  gpuPercent: number | null;
  gpuMemory: number | null;
  terminable: boolean;
  truncated: boolean;
}
