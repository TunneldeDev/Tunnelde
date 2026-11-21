import { useLayoutEffect, useRef } from "react";
import { usePanelViewController } from "@/lib/panels/viewState";

/** Capture-time safety, not an OS-effect fence. Native admission must still
 * independently pin actual work; never serialize provider authority or replay UI
 * consent/connection acquisition as an ordinary draft in another document. */
export function useForwardingCaptureGuard(key: string, blocked: () => boolean) {
  const controller = usePanelViewController();
  const current = useRef(blocked);
  useLayoutEffect(() => {
    current.current = blocked;
  });
  useLayoutEffect(
    () =>
      controller?.register(key, () => {
        if (current.current()) throw new Error("panels.finishInteractionBeforeMoving");
        return null;
      }),
    [controller, key],
  );
}
