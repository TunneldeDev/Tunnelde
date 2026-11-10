import type { FrontendMonitor, FrontendMonitorSnapshot } from "../contracts/monitor/provider";
import type { FrontendMonitorSample } from "../contracts/monitor/sample";

export type MonitorContext = Pick<FrontendMonitor, "snapshot" | "read" | "refresh">;
const metric = (value: number | null) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

/** Independent bounded projection: never pass internal store objects to a renderer. */
export function createMonitorContext(
  snapshot: FrontendMonitorSnapshot,
  samples: readonly FrontendMonitorSample[],
  validate: () => boolean,
  refresh: () => void,
): MonitorContext {
  const rows = Object.freeze(
    samples.slice(-240).map((sample) =>
      Object.freeze({
        at: sample.at,
        cpu: metric(sample.cpu),
        memory: metric(sample.memory),
        disk: metric(sample.disk),
        rx: metric(sample.rx),
        tx: metric(sample.tx),
        diskRead: metric(sample.diskRead),
        diskWrite: metric(sample.diskWrite),
      }),
    ),
  );
  const reading = snapshot.latest;
  const latest = reading
    ? Object.freeze({
        cpuCount: metric(reading.cpuCount),
        memoryUsed: metric(reading.memoryUsed),
        memoryTotal: metric(reading.memoryTotal),
        swapUsed: metric(reading.swapUsed),
        swapTotal: metric(reading.swapTotal),
        diskUsed: metric(reading.diskUsed),
        diskTotal: metric(reading.diskTotal),
        uptime: metric(reading.uptime),
        load: Object.freeze([
          metric(reading.load[0]),
          metric(reading.load[1]),
          metric(reading.load[2]),
        ] as const),
      })
    : null;
  const data = Object.freeze({
    sessionId: snapshot.sessionId,
    hostId: snapshot.hostId,
    title: snapshot.title,
    revision: snapshot.revision,
    presentation: snapshot.presentation,
    latest,
    total: rows.length,
    sampling: snapshot.sampling,
    busy: snapshot.busy,
    error: snapshot.error,
  });
  return Object.freeze({
    snapshot: data,
    read: (request) => {
      if (!request || typeof request !== "object") throw new Error("plugin.monitor.invalid");
      if (request.revision !== data.revision) throw new Error("plugin.monitor.changed");
      const offset = request.offset ?? 0;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > rows.length)
        throw new Error("plugin.monitor.invalid");
      const end = Math.min(offset + 128, rows.length);
      return Object.freeze({
        revision: data.revision,
        total: rows.length,
        nextOffset: end < rows.length ? end : null,
        items: Object.freeze(rows.slice(offset, end)),
      });
    },
    refresh: () => {
      if (!validate()) throw new Error("plugin.monitor.changed");
      if (!data.sampling) throw new Error("plugin.monitor.inactive");
      refresh();
    },
  } satisfies MonitorContext);
}
