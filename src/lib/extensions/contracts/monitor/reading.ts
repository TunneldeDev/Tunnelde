/** Latest absolute resource values. Process data has a separate lifecycle and API. */
export interface FrontendMonitorReading {
  cpuCount: number | null;
  memoryUsed: number | null;
  memoryTotal: number | null;
  swapUsed: number | null;
  swapTotal: number | null;
  diskUsed: number | null;
  diskTotal: number | null;
  uptime: number | null;
  load: readonly [number | null, number | null, number | null];
}
