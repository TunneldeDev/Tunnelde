import type { FsSource } from "@/lib/api/types";

/** Exact request coordinates, not canonical filesystem identity or ownership. */
export function captureFileTarget(path: string, source: FsSource) {
  return Object.freeze({
    path,
    source: Object.freeze(
      source.kind === "local"
        ? { kind: "local" as const }
        : { kind: "remote" as const, sessionId: source.sessionId },
    ),
  });
}
