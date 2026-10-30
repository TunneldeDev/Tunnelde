// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { Check, ChevronDown } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/format";

export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  /** Accessible name; also used as the tooltip-free label. */
  label: string;
  id?: string;
  className?: string;
  disabled?: boolean;
}

const POPUP_MAX_HEIGHT = 280;

/**
 * A listbox drawn with the app's own tokens. The native `<select>` popup is
 * rendered by the OS and cannot follow the theme, so every dropdown in the
 * product uses this instead.
 */
export function Select({
  value,
  options,
  onChange,
  label,
  id,
  className,
  disabled,
}: SelectProps) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [position, setPosition] = useState<{ top: number; left: number; width: number } | null>(
    null,
  );
  const rootRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  const current = options[selectedIndex] ?? null;

  useLayoutEffect(() => {
    if (!open || !buttonRef.current) {
      return;
    }
    const rect = buttonRef.current.getBoundingClientRect();
    const height = Math.min(POPUP_MAX_HEIGHT, options.length * 28 + 8);
    const flip = rect.bottom + height + 8 > window.innerHeight;
    setPosition({
      top: flip ? Math.max(8, rect.top - height - 4) : rect.bottom + 4,
      left: Math.max(8, Math.min(rect.left, window.innerWidth - rect.width - 8)),
      width: rect.width,
    });
  }, [open, options.length]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (rootRef.current?.contains(target) || popupRef.current?.contains(target)) {
        return;
      }
      setOpen(false);
    };
    const onWindowChange = () => setOpen(false);
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("resize", onWindowChange);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("resize", onWindowChange);
    };
  }, [open]);

  const commit = (index: number) => {
    const option = options[index];
    setOpen(false);
    if (option && option.value !== value) {
      onChange(option.value);
    }
  };

  const show = () => {
    setHighlight(selectedIndex);
    setOpen(true);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape" && open) {
      event.preventDefault();
      setOpen(false);
      return;
    }
    if ((event.key === "Enter" || event.key === " ") && !open) {
      event.preventDefault();
      show();
      return;
    }
    if (!open) {
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setHighlight((index) => (index + delta + options.length) % options.length);
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      setHighlight(event.key === "Home" ? 0 : options.length - 1);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      commit(highlight);
    }
  };

  return (
    <span className={cn("td-select", className)} ref={rootRef}>
      <button
        type="button"
        ref={buttonRef}
        id={id}
        disabled={disabled}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={cn("td-input", "td-select__control", open && "is-open")}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={onKeyDown}
      >
        <span className="td-select__value">{current?.label ?? value}</span>
        <ChevronDown size={13} aria-hidden="true" className="td-select__chevron" />
      </button>
      {open && position
        ? createPortal(
            <div
              ref={popupRef}
              role="listbox"
              aria-label={label}
              tabIndex={-1}
              className="td-select__popup"
              style={{ top: position.top, left: position.left, minWidth: position.width }}
              onKeyDown={onKeyDown}
            >
              {options.map((option, index) => (
                <button
                  key={option.value}
                  type="button"
                  role="option"
                  aria-selected={option.value === value}
                  className={cn("td-select__option", index === highlight && "is-highlight")}
                  onMouseEnter={() => setHighlight(index)}
                  onClick={() => commit(index)}
                >
                  <span>{option.label}</span>
                  {option.value === value ? <Check size={12} aria-hidden="true" /> : null}
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </span>
  );
}
