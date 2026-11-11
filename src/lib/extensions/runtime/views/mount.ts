import type { ResourceScope } from "../scopes/contracts";

/** Construction is inert. Only a committed effect may acquire a module reservation. */
export function createViewMount(
  open: () => ResourceScope,
  report: (error: unknown) => void,
  retain?: (release: () => void) => () => void,
) {
  let current: ResourceScope | null = null;
  const listeners = new Set<() => void>();
  const changed = () => {
    for (const receive of listeners) receive();
  };
  return {
    snapshot: () => current,
    subscribe(receive: () => void) {
      listeners.add(receive);
      return () => {
        listeners.delete(receive);
      };
    },
    activate() {
      let scope: ResourceScope | undefined;
      let release: (() => void) | undefined;
      const closed = () => {
        if (current !== scope) return;
        current = null;
        changed();
      };
      try {
        scope = open();
        release = retain?.(scope.dispose);
        if (scope.signal.aborted) throw new Error("extension.scope.closed");
        scope.signal.addEventListener("abort", closed, { once: true });
        current = scope;
        changed();
      } catch (error) {
        scope?.dispose();
        release?.();
        report(error);
      }
      return () => {
        scope?.signal.removeEventListener("abort", closed);
        closed();
        scope?.dispose();
        release?.();
      };
    },
  };
}
