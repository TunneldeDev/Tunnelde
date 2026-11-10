/** Sorting uses known finite nonnegative metrics, with unknown values last. */
export type FrontendProcessColumn =
  | "name"
  | "pid"
  | "userName"
  | "cpuTotal"
  | "rss"
  | "diskReadRate"
  | "diskWriteRate"
  | "networkRxRate"
  | "networkTxRate"
  | "gpuPercent"
  | "gpuMemory";
export interface FrontendProcessSort {
  key: FrontendProcessColumn;
  descending: boolean;
}
