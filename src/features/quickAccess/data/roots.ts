import type { SshSession } from "@/lib/api/types";
import type { EditorEntry } from "@/store/editors";
import type { SearchRoot } from "@/store/searchRoots";
import { searchParent, searchPathKey } from "@/lib/files/searchPaths";
export function quickAccessRoots(
  published: Record<string, SearchRoot[]>,
  entries: Record<string, EditorEntry>,
  picked: SearchRoot | null,
  activeTabId: string | null,
  sessions: readonly SshSession[],
) {
  const candidates = [
    ...Object.values(published).flat(),
    ...Object.values(entries).map((entry) => ({
      id: `editor:${entry.tabId}`,
      tabId: entry.tabId,
      sessionId: entry.sessionId,
      path: searchParent(entry.path, entry.sessionId),
    })),
    ...(picked ? [picked] : []),
  ];
  candidates.sort((a, b) => Number(b.tabId === activeTabId) - Number(a.tabId === activeTabId));
  const seen = new Set<string>();
  return candidates.filter((root) => {
    const key = `${root.sessionId ?? "local"}\0${searchPathKey(root.path, root.sessionId)}`;
    if (
      seen.has(key) ||
      (root.sessionId && !sessions.some((session) => session.id === root.sessionId))
    )
      return false;
    seen.add(key);
    return true;
  });
}
