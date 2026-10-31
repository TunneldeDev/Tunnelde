// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { useRef, type PointerEvent } from "react";

import { cn } from "@/lib/text/format";

interface ResizerProps {
  value: number;
  min: number;
  max: number;
  edge: "left" | "right";
  label: string;
  onChange: (value: number) => void;
  onCommit: (value: number) => void;
}

/**
 * Vertical drag handle between panels. Updates stay local while dragging and
 * are persisted once on release.
 */
export function Resizer({ value, min, max, edge, label, onChange, onCommit }: ResizerProps) {
  const drag = useRef({ startX: 0, startValue: 0, latest: 0, active: false });

  const clamp = (next: number) => Math.round(Math.min(max, Math.max(min, next)));

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    drag.current = {
      startX: event.clientX,
      startValue: value,
      latest: value,
      active: true,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current.active) {
      return;
    }
    // A scaled display reports fractional client coordinates; keep whole pixels
    // so the persisted width stays an integer.
    const delta = (event.clientX - drag.current.startX) * (edge === "right" ? 1 : -1);
    const next = clamp(drag.current.startValue + delta);
    if (!Number.isFinite(next)) {
      return;
    }
    drag.current.latest = next;
    onChange(next);
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current.active) {
      return;
    }
    drag.current.active = false;
    event.currentTarget.releasePointerCapture(event.pointerId);
    // Commit what the drag ended on, not the value the render started with.
    onCommit(drag.current.latest);
  };

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      className={cn("td-resizer", `td-resizer--${edge}`)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    />
  );
}
