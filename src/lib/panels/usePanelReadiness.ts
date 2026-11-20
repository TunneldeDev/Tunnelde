import { useLayoutEffect, useRef } from "react";
import { usePanelViewController } from "./viewState";
import { createPanelReadiness } from "./readiness";

/** Register before the parent's layout readiness check. Resolve only from a
 * committed render, after child factories have registered their own readiness.
 * The null field holds capture until discovery; it carries no action authority. */
export function usePanelReadiness(key: string | null, ready: boolean, error?: unknown) {
  const controller = usePanelViewController();
  const current = useRef<ReturnType<typeof createPanelReadiness> | null>(null);
  useLayoutEffect(() => {
    if (key === null) return;
    const binding = createPanelReadiness();
    current.current = binding;
    const unregister = controller?.register(
      key,
      () => {
        binding.check();
        return null;
      },
      async (signal) => {
        await binding.wait(signal);
        return null;
      },
      binding.wait,
    );
    return () => {
      unregister?.();
      binding.dispose();
      if (current.current === binding) current.current = null;
    };
  }, [controller, key]);
  useLayoutEffect(() => {
    current.current?.commit(ready, error);
  });
}
