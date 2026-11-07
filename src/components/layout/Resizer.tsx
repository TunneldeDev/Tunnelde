import { useLayoutEffect, useRef } from "react";

import { usePointerDrag } from "@/lib/session/usePointerDrag";
import { cn } from "@/lib/text/format";

interface ResizerProps {
  value: number;
  min: number;
  max: number;
  edge: "left" | "right";
  label: string;
  /** Preview dimensions without persisting or rerendering the workbench. */
  onChange: (value: number) => void;
  onCommit: (value: number) => void;
}

/** Preview once per frame; save only a completed gesture. */
export function Resizer(props: ResizerProps) {
  const { value, min, max, edge, label } = props;
  const current = useRef(props);
  useLayoutEffect(() => {
    current.current = props;
  });
  const beginResize = usePointerDrag();
  const clamp = (next: number) => Math.round(Math.min(max, Math.max(min, next)));
  return (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      className={cn("td-resizer", `td-resizer--${edge}`)}
      onPointerDown={(event) => {
        const handle = event.currentTarget;
        const origin = event.clientX;
        let latest = value;
        let reported = value;
        const preview = (next: number) => {
          handle.setAttribute("aria-valuenow", String(next));
          if (reported !== next) {
            reported = next;
            current.current.onChange(next);
          }
        };
        beginResize(event, {
          move: (next) => {
            if (!Number.isFinite(next.clientX)) return;
            latest = clamp(value + (next.clientX - origin) * (edge === "right" ? 1 : -1));
            preview(latest);
          },
          commit: () => {
            if (latest !== value) current.current.onCommit(latest);
            else preview(current.current.value);
          },
          cancel: () => preview(current.current.value),
        });
      }}
      onKeyDown={(event) => {
        const direction = edge === "right" ? 1 : -1;
        const next =
          event.key === "ArrowRight"
            ? value + direction * 10
            : event.key === "ArrowLeft"
              ? value - direction * 10
              : event.key === "Home"
                ? min
                : event.key === "End"
                  ? max
                  : null;
        if (next === null) return;
        event.preventDefault();
        event.stopPropagation();
        const clamped = clamp(next);
        if (clamped !== value) current.current.onCommit(clamped);
      }}
    />
  );
}
