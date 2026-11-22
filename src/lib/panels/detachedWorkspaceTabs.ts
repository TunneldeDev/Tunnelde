/** Main-document bookkeeping for workspace tabs temporarily owned by a
 * satellite. Native leases are still authoritative; these records only prevent
 * a stale pre-transfer snapshot from making the source tab visible again. */
const detached = new Map<string, { tabId: string; generation: number }>();

export function rememberDetachedWorkspaceTab(panelId: string, tabId: string, generation: number) {
  detached.set(panelId, { tabId, generation });
}

export function workspaceTabReturnedToMain(panelId: string, generation: number) {
  const record = detached.get(panelId);
  if (!record || generation === record.generation) return false;
  detached.delete(panelId);
  return true;
}

export function forgetDetachedWorkspaceTab(panelId: string) {
  detached.delete(panelId);
}

/** Drop bookkeeping only when its owning workspace tab was actually removed.
 * A hidden tab remains a valid return target. */
export function retainDetachedWorkspaceTabs(tabIds: ReadonlySet<string>) {
  for (const [panelId, record] of detached) if (!tabIds.has(record.tabId)) detached.delete(panelId);
}
