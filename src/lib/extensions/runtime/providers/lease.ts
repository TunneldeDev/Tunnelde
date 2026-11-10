/** Retained subscriptions belong to one committed provider generation. */
export function createProviderLease() {
  let closed = false;
  const subscriptions = new Set<() => void>();
  return {
    isClosed: () => closed,
    activate: () => {
      closed = false;
    },
    close: () => {
      closed = true;
      for (const release of [...subscriptions]) release();
    },
    retain: (release: () => void) => {
      const cleanup = () => {
        if (!subscriptions.delete(cleanup)) return;
        release();
      };
      subscriptions.add(cleanup);
      return cleanup;
    },
  };
}
