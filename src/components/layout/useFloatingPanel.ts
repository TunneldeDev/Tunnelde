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
import { usePointerDragController } from "@/lib/session/usePointerDrag";
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
  enabled: boolean,
) {
  const [active, setActive] = useState(false);
  const { begin: beginDrag, cancel: cancelDrag } = usePointerDragController();
  useBackgroundGuard(active);
  const gesture = useRef<{
    latest: FloatingRect;
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
  function finish(cancel: boolean) {
    const drag = gesture.current;
    if (!drag) return;
    gesture.current = null;
    document.body.style.cursor = drag.cursor;
    document.body.style.userSelect = drag.userSelect;
    paint(
      cancel ? (drag.saved ? clampFloatingRect(drag.saved, availableArea()) : null) : drag.latest,
    );
    if (!cancel) commit.current(drag.latest);
    setActive(false);
  }
  useLayoutEffect(() => {
    if (!enabled) cancelDrag();
    paint(enabled && bounds ? clampFloatingRect(bounds, availableArea()) : null);
    // Geometry is committed only on release, reset or viewport changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bounds, enabled]);
  useLayoutEffect(() => {
    if (!enabled) return;
    const resize = () => {
      if (document.hidden || !panel.current?.getClientRects().length) return;
      cancelDrag();
      if (panel.current?.style.left) {
        const rect = panel.current.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;
        const next = clampFloatingRect(
          { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          availableArea(),
        );
        paint(next);
        commit.current(next);
      }
    };
    window.addEventListener("resize", resize);
    return () => {
      cancelDrag();
      window.removeEventListener("resize", resize);
    };
    // Shared pointer ownership handles release, Escape, capture loss and blur.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panel, enabled]);

  return {
    reset() {
      cancelDrag();
      paint(null);
      onCommit(null);
    },
    handle(action: FloatingAction) {
      return {
        onPointerDown(event: PointerEvent<HTMLElement>) {
          if (!enabled || event.button !== 0 || gesture.current || !panel.current) return;
          const start = read();
          const origin = { x: event.clientX, y: event.clientY };
          gesture.current = {
            latest: start,
            saved: bounds ? start : null,
            cursor: document.body.style.cursor,
            userSelect: document.body.style.userSelect,
          };
          document.body.style.cursor = action === "move" ? "grabbing" : `${action}-resize`;
          document.body.style.userSelect = "none";
          setActive(true);
          beginDrag(event, {
            move(next) {
              const drag = gesture.current;
              if (!drag) return;
              drag.latest = adjustFloatingRect(
                start,
                action,
                next.clientX - origin.x,
                next.clientY - origin.y,
                availableArea(),
              );
              paint(drag.latest);
            },
            commit: () => finish(false),
            cancel: () => finish(true),
          });
        },
        onKeyDown(event: KeyboardEvent<HTMLElement>) {
          if (
            !enabled ||
            !event.key.startsWith("Arrow") ||
            event.altKey ||
            event.ctrlKey ||
            event.metaKey
          )
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
