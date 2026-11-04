import {
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
  type PointerEvent,
  type KeyboardEvent,
} from "react";
import {
  adjustFloatingRect,
  clampFloatingRect,
  type FloatingAction,
  type FloatingRect,
} from "@/lib/layout/floatingPanel";
import { useBackgroundGuard } from "@/lib/session/viewState";

function availableArea(): FloatingRect {
  const title = document.querySelector(".window-titlebar")?.getBoundingClientRect().bottom ?? 0;
  const status = document.querySelector(".statusbar")?.getBoundingClientRect().height ?? 36;
  const x = Math.min(8, window.innerWidth / 4);
  const y = Math.min(title + 8, window.innerHeight / 4);
  return {
    x,
    y,
    width: Math.max(1, window.innerWidth - x * 2),
    height: Math.max(1, window.innerHeight - y - status - 8),
  };
}

/** Preview geometry directly so progress rows do not rerender for every pointer move. */
export function useFloatingPanel(
  panel: RefObject<HTMLElement | null>,
  bounds: FloatingRect | null,
  onCommit: (bounds: FloatingRect | null) => void,
) {
  const [active, setActive] = useState(false);
  useBackgroundGuard(active);
  const gesture = useRef<{
    pointerId: number;
    target: HTMLElement;
    start: FloatingRect;
    latest: FloatingRect;
    action: FloatingAction;
    x: number;
    y: number;
    saved: FloatingRect | null;
    cursor: string;
    userSelect: string;
  } | null>(null);
  const commit = useRef(onCommit);
  useLayoutEffect(() => {
    commit.current = onCommit;
  }, [onCommit]);

  function paint(rect: FloatingRect | null) {
    if (!panel.current) return;
    const style = panel.current.style;
    if (!rect) {
      for (const name of ["left", "top", "width", "height", "right", "bottom", "max-height"])
        style.removeProperty(name);
      return;
    }
    Object.assign(style, {
      left: `${rect.x}px`,
      top: `${rect.y}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
      right: "auto",
      bottom: "auto",
      maxHeight: "none",
    });
  }
  function read(): FloatingRect {
    const rect = panel.current!.getBoundingClientRect();
    return clampFloatingRect(
      { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      availableArea(),
    );
  }
  function finish(cancel: boolean, updateState = true) {
    const drag = gesture.current;
    if (!drag) return;
    gesture.current = null;
    document.body.style.cursor = drag.cursor;
    document.body.style.userSelect = drag.userSelect;
    if (drag.target.hasPointerCapture(drag.pointerId))
      drag.target.releasePointerCapture(drag.pointerId);
    paint(
      cancel ? (drag.saved ? clampFloatingRect(drag.saved, availableArea()) : null) : drag.latest,
    );
    if (!cancel) commit.current(drag.latest);
    if (updateState) setActive(false);
  }
  const finishRef = useRef(finish);
  useLayoutEffect(() => {
    finishRef.current = finish;
  });
  useLayoutEffect(() => {
    paint(bounds ? clampFloatingRect(bounds, availableArea()) : null);
    // Geometry is committed only on release, reset or viewport changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bounds]);
  useLayoutEffect(() => {
    const resize = () => {
      finishRef.current(false);
      if (panel.current?.style.left) {
        const rect = panel.current.getBoundingClientRect();
        const next = clampFloatingRect(
          { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          availableArea(),
        );
        paint(next);
        commit.current(next);
      }
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && gesture.current) {
        event.preventDefault();
        event.stopPropagation();
        finishRef.current(true);
      }
    };
    window.addEventListener("resize", resize);
    document.addEventListener("keydown", escape, true);
    return () => {
      finishRef.current(true, false);
      window.removeEventListener("resize", resize);
      document.removeEventListener("keydown", escape, true);
    };
    // The handlers read the latest gesture/commit through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel]);

  return {
    reset() {
      finish(true);
      paint(null);
      onCommit(null);
    },
    handle(action: FloatingAction) {
      return {
        onPointerDown(event: PointerEvent<HTMLElement>) {
          if (event.button !== 0 || gesture.current || !panel.current) return;
          event.preventDefault();
          const start = read();
          gesture.current = {
            pointerId: event.pointerId,
            target: event.currentTarget,
            start,
            latest: start,
            action,
            x: event.clientX,
            y: event.clientY,
            saved: bounds ? start : null,
            cursor: document.body.style.cursor,
            userSelect: document.body.style.userSelect,
          };
          document.body.style.cursor = action === "move" ? "grabbing" : `${action}-resize`;
          document.body.style.userSelect = "none";
          event.currentTarget.setPointerCapture(event.pointerId);
          setActive(true);
        },
        onPointerMove(event: PointerEvent<HTMLElement>) {
          const drag = gesture.current;
          if (!drag || drag.pointerId !== event.pointerId) return;
          drag.latest = adjustFloatingRect(
            drag.start,
            action,
            event.clientX - drag.x,
            event.clientY - drag.y,
            availableArea(),
          );
          paint(drag.latest);
        },
        onPointerUp(event: PointerEvent<HTMLElement>) {
          if (gesture.current?.pointerId === event.pointerId) finish(false);
        },
        onPointerCancel(event: PointerEvent<HTMLElement>) {
          if (gesture.current?.pointerId === event.pointerId) finish(true);
        },
        onLostPointerCapture(event: PointerEvent<HTMLElement>) {
          if (gesture.current?.pointerId === event.pointerId) finish(false);
        },
        onKeyDown(event: KeyboardEvent<HTMLElement>) {
          if (!event.key.startsWith("Arrow") || event.altKey || event.ctrlKey || event.metaKey)
            return;
          const step = event.shiftKey ? 1 : 10;
          const dx = event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0;
          const dy = event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0;
          if (!dx && !dy) return;
          event.preventDefault();
          event.stopPropagation();
          const next = adjustFloatingRect(read(), action, dx, dy, availableArea());
          paint(next);
          onCommit(next);
        },
      };
    },
  };
}
