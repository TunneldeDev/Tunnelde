import { useLayoutEffect, useRef, type CSSProperties, type ReactNode } from "react";
import type { SplitDirection } from "@/lib/layout/types";
import { usePointerDrag } from "@/lib/session/usePointerDrag";
import { cn } from "@/lib/text/format";
import "./splitPanels.css";

export interface SplitPanelsProps {
  direction?: SplitDirection;
  ratio: number;
  onRatioChange: (ratio: number) => void;
  first: ReactNode;
  second: ReactNode;
  label: string;
  minRatio?: number;
  maxRatio?: number;
  homeRatio?: number;
  resetRatio?: number;
  step?: number;
  separatorSize?: number;
  mode?: "flex" | "grid";
  className?: string;
  childClassName?: string;
  separatorClassName?: string;
}

/** Controlled geometry with frame-bound DOM previews; children and persistence update only on commit. */
export function SplitPanels({
  direction = "row",
  ratio,
  onRatioChange,
  first,
  second,
  label,
  minRatio = 0.15,
  maxRatio = 0.85,
  resetRatio = 0.5,
  homeRatio = minRatio,
  step = 0.05,
  separatorSize = 4,
  mode = "flex",
  className,
  childClassName,
  separatorClassName,
}: SplitPanelsProps) {
  const panel = useRef<HTMLDivElement>(null);
  const beginResize = usePointerDrag();
  const clamp = (value: number) =>
    Math.max(minRatio, Math.min(maxRatio, Number.isFinite(value) ? value : resetRatio));
  const current = clamp(ratio);
  const savedRatio = useRef(current);
  const onChange = useRef(onRatioChange);
  useLayoutEffect(() => {
    savedRatio.current = current;
    onChange.current = onRatioChange;
  }, [current, onRatioChange]);
  const horizontal = direction === "row";
  const grid = (value: number) => {
    const percent = Number((value * 100).toFixed(8));
    return `minmax(0, ${percent}fr) ${separatorSize}px minmax(0, ${100 - percent}fr)`;
  };
  const commit = (value: number) => {
    const next = clamp(value);
    if (next !== savedRatio.current) onChange.current(next);
  };
  const style: CSSProperties & { "--td-split-ratio": number; "--td-split-size": string } = {
    "--td-split-ratio": current,
    "--td-split-size": `${separatorSize}px`,
    display: mode === "grid" ? "grid" : "flex",
    flexDirection: direction,
    ...(mode === "grid"
      ? horizontal
        ? { gridTemplateColumns: grid(current) }
        : { gridTemplateRows: grid(current) }
      : {}),
    flex: "1 1 0",
    minWidth: 0,
    minHeight: 0,
    overflow: "hidden",
  };
  return (
    <div ref={panel} className={cn("td-split-panels", className)} style={style}>
      {mode === "grid" ? (
        first
      ) : (
        <div
          className={cn("td-split-panels__child", childClassName)}
          style={{ flex: "var(--td-split-ratio) 1 0px" }}
        >
          {first}
        </div>
      )}
      <div
        className={cn("td-split-panels__separator", separatorClassName)}
        role="separator"
        tabIndex={0}
        aria-label={label}
        aria-orientation={horizontal ? "vertical" : "horizontal"}
        aria-valuemin={Math.round(minRatio * 100)}
        aria-valuemax={Math.round(maxRatio * 100)}
        aria-valuenow={Math.round(current * 100)}
        style={{
          flex: `0 0 ${separatorSize}px`,
          cursor: horizontal ? "col-resize" : "row-resize",
          touchAction: "none",
        }}
        onPointerDown={(event) => {
          const root = panel.current;
          if (!root) return;
          const handle = event.currentTarget;
          const origin = horizontal ? event.clientX : event.clientY;
          let latest = current;
          const preview = (value: number) => {
            root.style.setProperty("--td-split-ratio", String(value));
            if (mode === "grid") {
              if (horizontal) root.style.gridTemplateColumns = grid(value);
              else root.style.gridTemplateRows = grid(value);
            }
            handle.setAttribute("aria-valuenow", String(Math.round(value * 100)));
          };
          beginResize(event, {
            move: (next) => {
              const rect = root.getBoundingClientRect();
              const separator = handle.getBoundingClientRect();
              const size = horizontal
                ? rect.width - separator.width
                : rect.height - separator.height;
              const position = horizontal ? next.clientX : next.clientY;
              if (size <= 0 || !Number.isFinite(position)) return;
              latest = clamp(current + (position - origin) / size);
              preview(latest);
            },
            commit: () => {
              if (latest !== current) commit(latest);
              else preview(savedRatio.current);
            },
            cancel: () => preview(savedRatio.current),
          });
        }}
        onDoubleClick={() => commit(resetRatio)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          const decrease = horizontal ? "ArrowLeft" : "ArrowUp";
          const increase = horizontal ? "ArrowRight" : "ArrowDown";
          const next =
            event.key === decrease
              ? current - step
              : event.key === increase
                ? current + step
                : event.key === "Home"
                  ? homeRatio
                  : event.key === "End"
                    ? maxRatio
                    : null;
          if (next == null) return;
          event.preventDefault();
          event.stopPropagation();
          commit(next);
        }}
      />
      {mode === "grid" ? (
        second
      ) : (
        <div
          className={cn("td-split-panels__child", childClassName)}
          style={{ flex: "calc(1 - var(--td-split-ratio)) 1 0px" }}
        >
          {second}
        </div>
      )}
    </div>
  );
}
