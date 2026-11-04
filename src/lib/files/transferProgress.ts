export interface TransferSample {
  at: number;
  bytes: number;
}
export interface TransferRate {
  samples: TransferSample[];
  baseline: number;
}
const WINDOW_MS = 5000;

export function sampleTransfer(
  previous: TransferRate | undefined,
  bytes: number,
  at: number,
): TransferRate {
  const baseline = previous?.baseline ?? bytes;
  const current = { at, bytes: Math.max(baseline, bytes) };
  const samples = previous ? [...previous.samples] : [];
  // Keep one anchor before the rolling window and at most four samples per second.
  while (samples.length > 1 && samples[1]!.at <= at - WINDOW_MS) samples.shift();
  if (samples.length > 1 && at - samples.at(-1)!.at < 250) samples[samples.length - 1] = current;
  else samples.push(current);
  return { baseline, samples };
}

export function transferProgress(
  item: {
    transferred: number;
    total: number;
    status: string;
    rate?: TransferRate;
  },
  now: number,
) {
  const transferred = Math.max(0, item.transferred);
  const total =
    item.total > 0
      ? Math.max(item.total, transferred)
      : item.status === "done"
        ? transferred
        : null;
  const remaining = total === null ? null : Math.max(0, total - transferred);
  const samples = item.rate?.samples;
  const first = samples?.[0],
    last = samples?.at(-1);
  const seconds = first ? (now - first.at) / 1000 : 0;
  const speed =
    item.status !== "running" || !first || !last || seconds <= 0
      ? null
      : now - last.at >= WINDOW_MS
        ? 0
        : Math.max(0, (last.bytes - first.bytes) / seconds);
  return {
    transferred,
    total,
    remaining,
    speed,
    percent:
      item.status === "done"
        ? 100
        : total && total > 0
          ? Math.min(100, (transferred / total) * 100)
          : null,
    eta: remaining !== null && speed !== null && speed > 0 ? Math.ceil(remaining / speed) : null,
  };
}

export function durationParts(seconds: number) {
  const rounded = Math.max(1, Math.ceil(seconds));
  return {
    hours: Math.floor(rounded / 3600),
    minutes: Math.floor((rounded % 3600) / 60),
    seconds: rounded % 60,
  };
}
