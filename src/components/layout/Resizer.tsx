// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { useRef, type PointerEvent } from "react";

import { cn } from "@/lib/format";

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
  const drag = useRef({ startX: 0, startValue: 0, active: false });

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    drag.current = { startX: event.clientX, startValue: value, active: true };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current.active) {
      return;
    }
    const delta = (event.clientX - drag.current.startX) * (edge === "right" ? 1 : -1);
    onChange(Math.min(max, Math.max(min, drag.current.startValue + delta)));
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (!drag.current.active) {
      return;
    }
    drag.current.active = false;
    event.currentTarget.releasePointerCapture(event.pointerId);
    onCommit(value);
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
