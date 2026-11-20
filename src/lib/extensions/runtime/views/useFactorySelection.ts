import { useLayoutEffect, useState, useSyncExternalStore } from "react";
import { usePanelViewController } from "@/lib/panels/viewState";

/** A captured provider cannot silently become builtin contents when selection
 * changes between capture and destination discovery. Once its matching renderer
 * has committed, normal user selection changes may retire that restored draft.
 * Selection is metadata only; the actual factory still validates/restores state.
 */
export function useFactorySelection(
  enabled: boolean,
  selected: { pluginId: string; viewId: string } | null,
  pending: boolean,
) {
  const controller = usePanelViewController();
  const [binding] = useState(() => {
    let expected = enabled
      ? controller?.read(
          "plugin.factory",
          (value): value is Record<string, unknown> => value !== undefined,
        )
      : undefined;
    const listeners = new Set<() => void>();
    return {
      snapshot: () => expected,
      subscribe(listener: () => void) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      committed() {
        if (expected === undefined) return;
        expected = undefined;
        for (const listener of listeners) listener();
      },
    };
  });
  const expected = useSyncExternalStore(binding.subscribe, binding.snapshot);
  const matches =
    !!expected &&
    !!selected &&
    expected.pluginId === selected.pluginId &&
    expected.viewId === selected.viewId;
  useLayoutEffect(() => {
    if (!enabled || pending || !matches || !controller) return;
    const lifetime = new AbortController();
    // A matched async shell is not the restored renderer. The selection gate
    // itself is ready for this match; its child factory still owns real readiness.
    void controller.waitReady(lifetime.signal).then(
      () => {
        if (!lifetime.signal.aborted) binding.committed();
      },
      () => {},
    );
    return () => lifetime.abort();
  }, [binding, controller, enabled, pending, matches]);
  if (!enabled || pending || expected === undefined || matches) return undefined;
  return new Error("plugin.frontend.viewStateUnavailable");
}
