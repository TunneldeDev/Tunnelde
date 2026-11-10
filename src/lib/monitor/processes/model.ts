import type { RemoteProcess } from "@/lib/api/types";
export const processColumns = [
  "name",
  "pid",
  "userName",
  "cpuTotal",
  "rss",
  "diskReadRate",
  "diskWriteRate",
  "networkRxRate",
  "networkTxRate",
  "gpuPercent",
  "gpuMemory",
] as const;
export const knownProcessMetric = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
export const processIdentity = (process: RemoteProcess) =>
  `${process.pid}:${process.startedAtTicks ?? "unknown"}`;
