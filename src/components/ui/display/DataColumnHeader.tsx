import { useRef } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import "./dataColumnHeader.css";

const MIME = "application/x-tunnelde-data-column";
/** Controlled column header: pointer previews avoid rerendering every row. */
export function DataColumnHeader({
  id,
  label,
  source,
  width,
  sort,
  scope,
  onSort,
  onResize,
  onMove,
  resizeLabel,
  moveHint,
}: {
  id: string;
  label: string;
  source?: string;
  width: number;
  sort?: "asc" | "desc";
  scope: string;
  onSort: () => void;
  onResize: (width: number, commit: boolean) => void;
  onMove: (source: string, target: string) => void;
  resizeLabel: string;
  moveHint: string;
}) {
  const drag = useRef<{ pointer: number; x: number; width: number; next: number } | null>(null);
  const bound = (value: number) => Math.max(64, Math.min(480, Math.round(value)));
  return (
    <div
      role="columnheader"
      aria-sort={sort === "asc" ? "ascending" : sort === "desc" ? "descending" : "none"}
      className="td-column-header"
      onDragOver={(event) => {
        if (event.dataTransfer.types.includes(MIME)) {
          event.preventDefault();
          event.stopPropagation();
          event.dataTransfer.dropEffect = "move";
        }
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.types.includes(MIME)) return;
        event.preventDefault();
        event.stopPropagation();
        try {
          const data = JSON.parse(event.dataTransfer.getData(MIME));
          if (data.scope === scope && typeof data.id === "string") onMove(data.id, id);
        } catch {
          /* Ignore unrelated external drags. */
        }
      }}
    >
      <button
        className="td-column-header__label"
        title={[label, source, moveHint].filter(Boolean).join(" · ")}
        draggable
        onDragStart={(event) => {
          event.dataTransfer.setData(MIME, JSON.stringify({ scope, id }));
          event.dataTransfer.effectAllowed = "move";
          event.stopPropagation();
        }}
        onClick={onSort}
        onKeyDown={(event) => {
          if (event.altKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
            event.preventDefault();
            event.stopPropagation();
            const siblings = Array.from(
              event.currentTarget.parentElement?.parentElement?.querySelectorAll<HTMLElement>(
                "[data-column-key]",
              ) ?? [],
            );
            const index = siblings.findIndex((item) => item.dataset.columnKey === id);
            const target =
              siblings[index + (event.key === "ArrowLeft" ? -1 : 1)]?.dataset.columnKey;
            if (target) onMove(id, target);
          }
        }}
        data-column-key={id}
      >
        <span>{label}</span>
        {sort === "asc" ? <ArrowUp size={11} /> : sort === "desc" ? <ArrowDown size={11} /> : null}
      </button>
      <span
        role="separator"
        aria-orientation="vertical"
        aria-label={resizeLabel}
        aria-valuenow={width}
        aria-valuemin={64}
        aria-valuemax={480}
        tabIndex={0}
        className="td-column-header__resize"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.stopPropagation();
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { pointer: event.pointerId, x: event.clientX, width, next: width };
        }}
        onPointerMove={(event) => {
          const current = drag.current;
          if (!current || current.pointer !== event.pointerId) return;
          current.next = bound(current.width + event.clientX - current.x);
          onResize(current.next, false);
        }}
        onPointerUp={(event) => {
          const current = drag.current;
          if (!current || current.pointer !== event.pointerId) return;
          drag.current = null;
          onResize(current.next, true);
          event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onLostPointerCapture={() => {
          const current = drag.current;
          if (current) {
            drag.current = null;
            onResize(current.width, false);
          }
        }}
        onPointerCancel={() => {
          const current = drag.current;
          if (current) {
            drag.current = null;
            onResize(current.width, false);
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape" && drag.current) {
            event.preventDefault();
            event.stopPropagation();
            const current = drag.current;
            drag.current = null;
            onResize(current.width, false);
            event.currentTarget.releasePointerCapture(current.pointer);
            return;
          }
          const next =
            event.key === "ArrowLeft"
              ? width - 10
              : event.key === "ArrowRight"
                ? width + 10
                : event.key === "Home"
                  ? 64
                  : event.key === "End"
                    ? 480
                    : null;
          if (next !== null) {
            event.preventDefault();
            event.stopPropagation();
            onResize(bound(next), true);
          }
        }}
      />
    </div>
  );
}
