import { createContext, useCallback, useContext, useEffect, useRef, type ReactNode } from "react";
import type { PanelWindowClient } from "./windowClient";
import type { PanelLease, PanelViewAction } from "./windowProtocol";

export type PanelInteractionRelease = (() => Promise<void>) & { id?: string };

interface Gateway {
  client?: PanelWindowClient;
  lease?: PanelLease;
  staged: boolean;
}
const Context = createContext<Gateway | null>(null);
export function PanelInteractionScope({
  value,
  children,
}: {
  value: Gateway;
  children: ReactNode;
}) {
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function usePanelLeaseAction() {
  const scope = useContext(Context);
  return useCallback(
    (request: PanelViewAction): Promise<unknown> | undefined => {
      if (!scope) return undefined;
      if (!scope.client || !scope.lease || scope.staged)
        return Promise.reject(new Error("panel.window.staleOwner"));
      return scope.client.action(scope.lease, request);
    },
    [scope],
  );
}
/** Call before opening consent UI, not from an effect after it is already
 * interactive. Pending acquisition unmounts release their eventual token too.
 * These guards only protect document-local UI; submitted resource effects keep
 * their own host-side fence until completion, independently of component life.
 */
export function usePanelInteraction() {
  const scope = useContext(Context);
  const generation = useRef(0);
  const releases = useRef(new Set<() => Promise<void>>());
  useEffect(() => {
    const serial = ++generation.current;
    const current = releases.current;
    return () => {
      generation.current = serial + 1;
      for (const release of current) void release().catch(() => {});
    };
  }, []);
  return useCallback(async (): Promise<PanelInteractionRelease> => {
    if (!scope) return async () => {};
    if (!scope.client || !scope.lease || scope.staged) throw new Error("panel.window.staleOwner");
    const { client, lease } = scope;
    const serial = generation.current;
    const id = await client.control<string>({ action: "beginInteraction", lease });
    let pending: Promise<void> | undefined;
    const release = () => {
      pending ??= client
        .control<void>({ action: "endInteraction", lease, id })
        .then(() => {
          releases.current.delete(release);
        })
        .catch((error: unknown) => {
          pending = undefined;
          throw error;
        });
      return pending;
    };
    if (serial !== generation.current) {
      await release();
      throw new Error("panel.window.disposed");
    }
    releases.current.add(release);
    return Object.assign(release, { id });
  }, [scope]);
}
