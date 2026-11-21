import type { SshSession } from "@/lib/api/types";

export type SessionEventKind = "connected" | "disconnecting" | "disconnectFailed" | "ended";
export interface SessionHistory {
  session: SshSession;
  endedAt: number | null;
  events: { kind: SessionEventKind; at: number; detail?: string }[];
}

/** In-memory metadata only: never retain terminal output or connection credentials. */
export function recordSessionEvent(
  history: SessionHistory[],
  session: SshSession,
  kind: SessionEventKind,
  detail?: string,
): SessionHistory[] {
  const previous = history.find((entry) => entry.session.id === session.id);
  const at = kind === "connected" ? session.connectedAt : Date.now();
  const events = previous?.events ?? [{ kind: "connected" as const, at: session.connectedAt }];
  const entry: SessionHistory = {
    session,
    endedAt: kind === "ended" ? at : null,
    events:
      kind === "connected"
        ? events
        : [...events, { kind, at, ...(detail ? { detail } : {}) }].slice(-20),
  };
  const next = [entry, ...history.filter((item) => item.session.id !== session.id)];
  let ended = 0;
  return next.filter((item) => item.endedAt === null || ++ended <= 30);
}
