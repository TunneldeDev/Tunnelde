import type { SshSession } from "@/lib/api/types";
import type { SessionHistory } from "@/store/sshHistory";
import { matchesSearch, type SearchQuery } from "@/lib/search/query";

export const CONNECTION_FILTER_KEYS = ["type", "status", "host"] as const;
export function connectionType(session: SshSession) {
  return session.purpose === "forwarding" || session.purpose === "mounts"
    ? session.purpose
    : session.terminal === false
      ? "background"
      : "terminal";
}
export function connectionStatus(ended: boolean, pending: boolean, history?: SessionHistory) {
  return ended
    ? "ended"
    : pending
      ? "disconnecting"
      : history?.events.at(-1)?.kind === "disconnectFailed"
        ? "failed"
        : "connected";
}
export function matchesConnection(
  query: SearchQuery,
  session: SshSession,
  options: { host: string; status: string; labels?: string[] },
) {
  return matchesSearch(
    query,
    [
      session.title,
      session.address,
      session.id,
      session.hostId,
      options.host,
      connectionType(session),
      options.status,
      ...(options.labels ?? []),
    ].join(" "),
    { type: connectionType(session), status: options.status, host: [session.hostId, options.host] },
  );
}
