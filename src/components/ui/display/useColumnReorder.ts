import { useRef, type MouseEvent, type PointerEvent } from "react";
import { usePointerDrag } from "@/lib/session/usePointerDrag";

/** Reorders headers within one row without relying on native WebView drag-and-drop. */
export function useColumnReorder() {
  const begin = usePointerDrag();
  const draggedLabel = useRef<HTMLElement | null>(null);

  return {
    start(
      event: PointerEvent<HTMLElement>,
      onMove: (target: string, after: boolean) => void,
      viewport?: HTMLElement | null,
    ) {
      if (event.button !== 0) return;
      const label = event.currentTarget;
      const header = label.closest<HTMLElement>("[data-column-key]");
      const row = header?.parentElement;
      if (!header || !row) return;
      draggedLabel.current = null;
      label.focus({ preventScroll: true });
      const origin = { x: event.clientX, y: event.clientY };
      let moved = false;
      let destination: { key: string; after: boolean } | null = null;
      const headers = () => Array.from(row.querySelectorAll<HTMLElement>("[data-column-key]"));
      const clearTarget = () => {
        destination = null;
        for (const item of headers()) delete item.dataset.columnDrop;
      };
      const clear = () => {
        clearTarget();
        delete header.dataset.dragging;
      };
      begin(event, {
        move(next) {
          if (!moved && Math.hypot(next.clientX - origin.x, next.clientY - origin.y) < 5) return;
          moved = true;
          draggedLabel.current = label;
          header.dataset.dragging = "true";
          clearTarget();
          const bounds = row.getBoundingClientRect();
          if (next.clientY < bounds.top || next.clientY > bounds.bottom) return;
          if (viewport) {
            const clip = viewport.getBoundingClientRect();
            if (next.clientX < clip.left || next.clientX > clip.right) return;
            if (next.clientX < clip.left + 24) viewport.scrollLeft -= 24;
            else if (next.clientX > clip.right - 24) viewport.scrollLeft += 24;
          }
          for (const item of headers()) {
            const rect = item.getBoundingClientRect();
            if (next.clientX < rect.left || next.clientX > rect.right) continue;
            if (item === header) return;
            const after = next.clientX >= rect.left + rect.width / 2;
            item.dataset.columnDrop = after ? "after" : "before";
            destination = { key: item.dataset.columnKey!, after };
            return;
          }
        },
        commit() {
          const target = destination;
          clear();
          if (target) onMove(target.key, target.after);
        },
        cancel: clear,
      });
    },
    suppressClick(event: MouseEvent<HTMLElement>) {
      if (draggedLabel.current !== event.currentTarget || event.detail === 0) return false;
      draggedLabel.current = null;
      event.preventDefault();
      event.stopPropagation();
      return true;
    },
  };
}
