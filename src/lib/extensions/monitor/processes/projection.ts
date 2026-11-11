import type { RemoteProcess } from "@/lib/api/types";
import type { FrontendProcessEntry } from "../../contracts/monitor/processes/entry";
const metric = (value: number | undefined) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const text = (value: string | undefined, limit = 512) =>
  typeof value === "string" ? value.slice(0, limit) : null;

/** Copy every public field explicitly; internal process identity stays in the host. */
export function projectProcesses(items: readonly RemoteProcess[]) {
  return Object.freeze(
    items.map((process, index): Readonly<FrontendProcessEntry> =>
      Object.freeze({
        key: `process:${index}`,
        pid: process.pid,
        name: text(process.name) ?? "",
        userName: text(process.userName, 256),
        groupName: text(process.groupName, 256),
        uid: metric(process.uid),
        gid: metric(process.gid),
        parentPid: metric(process.parentPid),
        threads: metric(process.threads),
        state: text(process.state, 64),
        cpuTotal: metric(process.cpuTotal),
        cpuPerCore: metric(process.cpuTotal) !== null ? metric(process.cpu) : null,
        rss: metric(process.rss),
        diskReadRate: metric(process.diskReadRate),
        diskWriteRate: metric(process.diskWriteRate),
        networkRxRate: metric(process.networkRxRate),
        networkTxRate: metric(process.networkTxRate),
        gpuPercent: metric(process.gpuPercent),
        gpuMemory: metric(process.gpuMemory),
        terminable:
          Number.isSafeInteger(process.pid) &&
          process.pid > 1 &&
          Number.isSafeInteger(process.startedAtTicks) &&
          process.startedAtTicks! >= 0,
        truncated:
          process.name.length > 512 ||
          (process.userName?.length ?? 0) > 256 ||
          (process.groupName?.length ?? 0) > 256 ||
          (process.state?.length ?? 0) > 64,
      }),
    ),
  );
}
