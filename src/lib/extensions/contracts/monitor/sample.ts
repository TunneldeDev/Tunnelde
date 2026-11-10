/** Public experimental UI SDK 0.1.0 contract. Percentages use machine capacity. */
export interface FrontendMonitorSample {
  at: number;
  cpu: number | null;
  memory: number | null;
  disk: number | null;
  /** Network and disk rates are bytes per second; null means unavailable. */
  rx: number | null;
  tx: number | null;
  diskRead: number | null;
  diskWrite: number | null;
}
