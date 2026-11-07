import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";

interface PointerDrag {
  move: (event: PointerEvent) => void;
  commit: () => void;
  cancel: () => void;
}

/** Owns one pointer gesture; previews are frame-bound and are discarded on interruption. */
export function usePointerDrag() {
  const active = useRef<(() => void) | null>(null);
  const cancel = useCallback(() => active.current?.(), []);
  useEffect(() => cancel, [cancel]);

  return useCallback((event: ReactPointerEvent<HTMLElement>, drag: PointerDrag) => {
    if (event.button !== 0 || active.current) return;
    event.preventDefault();
    event.stopPropagation();
    const target = event.currentTarget;
    const pointerId = event.pointerId;
    let frame: number | null = null;
    let pending: PointerEvent | null = null;
    let ended = false;
    const flush = () => {
      frame = null;
      if (!pending) return;
      const next = pending;
      pending = null;
      drag.move(next);
    };
    const finish = (commit: boolean) => {
      if (ended) return;
      ended = true;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", interrupted);
      window.removeEventListener("blur", abort);
      window.removeEventListener("keydown", keydown, true);
      target.removeEventListener("lostpointercapture", interrupted);
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      active.current = null;
      if (commit) flush();
      else pending = null;
      if (target.hasPointerCapture?.(pointerId)) target.releasePointerCapture(pointerId);
      if (commit) drag.commit();
      else drag.cancel();
    };
    const abort = () => finish(false);
    const interrupted = (next: PointerEvent) => {
      if (next.pointerId === pointerId) abort();
    };
    const move = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      if (!target.isConnected || (next.buttons & 1) === 0) return abort();
      pending = next;
      if (frame === null) frame = requestAnimationFrame(flush);
    };
    const up = (next: PointerEvent) => {
      if (next.pointerId !== pointerId) return;
      if (!target.isConnected) return abort();
      pending = next;
      finish(true);
    };
    const keydown = (next: KeyboardEvent) => {
      if (next.key !== "Escape" || next.isComposing) return;
      next.preventDefault();
      next.stopPropagation();
      abort();
    };
    active.current = abort;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", interrupted);
    window.addEventListener("blur", abort);
    window.addEventListener("keydown", keydown, true);
    target.addEventListener("lostpointercapture", interrupted);
    // Global listeners also support hosts without pointer capture.
    try {
      target.setPointerCapture?.(pointerId);
    } catch {
      /* The pointer may have ended before capture was acquired. */
    }
  }, []);
}
