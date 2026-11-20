/** Snapshot identities once. UI filtering/model refresh must never broaden an
 * already confirmed batch. Independent failures do not stop the other items. */
export async function disconnectConnectionBatch(
  sessionIds: readonly string[],
  disconnect: (id: string) => Promise<void>,
) {
  const ids = [...new Set(sessionIds)];
  const failures = new Set<string>();
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, ids.length) }, async () => {
      while (next < ids.length) {
        const id = ids[next++]!;
        try {
          await disconnect(id);
        } catch {
          failures.add(id);
        }
      }
    }),
  );
  return {
    closed: ids.filter((id) => !failures.has(id)),
    failed: ids.filter((id) => failures.has(id)),
  };
}
