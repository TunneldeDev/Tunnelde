import type { Host, SshSession } from "@/lib/api/types";

/** A target is a saved host at an actual connected address, rather than a terminal tab. */
export function chatTargets(sessions: SshSession[], hosts: Host[], selectedId?: string) {
  const names = new Map(hosts.map((host) => [host.id, host.name]));
  const targets = new Map<string, SshSession>();
  for (const session of sessions) {
    const key = JSON.stringify([session.hostId || session.id, session.address]);
    const previous = targets.get(key);
    if (
      !previous ||
      session.id === selectedId ||
      (previous.id !== selectedId && session.connectedAt > previous.connectedAt)
    ) {
      targets.set(key, { ...session, title: names.get(session.hostId) || session.title });
    }
  }
  return [...targets.values()];
}
