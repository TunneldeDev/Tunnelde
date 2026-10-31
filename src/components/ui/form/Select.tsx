// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { Check, ChevronDown } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/text/format";

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
export function Select({ value, options, onChange, label, id, className, disabled }: SelectProps) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [position, setPosition] = useState<{ top: number; left: number; width: number } | null>(
    null,
  );
  const rootRef = useRef<HTMLSpanElement>(null);
  const listId = useId();
  const search = useRef({ text: "", at: 0 });
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  const current = options.find((option) => option.value === value) ?? null;
  if (disabled && open) setOpen(false);

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
    const onScroll = (event: Event) => {
      if (event.target instanceof Node && popupRef.current?.contains(event.target)) return;
      setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("resize", onWindowChange);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("resize", onWindowChange);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  useEffect(() => {
    if (open)
      popupRef.current
        ?.querySelector<HTMLElement>(`[data-option-index="${highlight}"]`)
        ?.scrollIntoView?.({ block: "nearest" });
  }, [highlight, open]);

  const commit = (index: number) => {
    const option = options[index];
    setOpen(false);
    buttonRef.current?.focus();
    if (option && option.value !== value) {
      onChange(option.value);
    }
  };

  const show = () => {
    if (disabled) return;
    search.current = { text: "", at: 0 };
    setHighlight(selectedIndex);
    setOpen(true);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (disabled || event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      buttonRef.current?.focus();
      return;
    }
    if ((event.key === "Enter" || event.key === " ") && !open) {
      event.preventDefault();
      show();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) {
        show();
        return;
      }
      if (options.length === 0) return;
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setHighlight((index) => (index + delta + options.length) % options.length);
      return;
    }
    if (event.key === "Tab") {
      setOpen(false);
      return;
    }
    if (
      event.key.length === 1 &&
      event.key !== " " &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.nativeEvent.isComposing
    ) {
      const at = Date.now();
      const text =
        (at - search.current.at < 700 ? search.current.text : "") + event.key.toLocaleLowerCase();
      search.current = { text, at };
      const found = options.findIndex((option) =>
        option.label.toLocaleLowerCase().startsWith(text),
      );
      if (found >= 0) {
        event.preventDefault();
        setOpen(true);
        setHighlight(found);
      }
      return;
    }
    if (!open) return;
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      setHighlight(event.key === "Home" ? 0 : options.length - 1);
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      commit(highlight);
    }
  };

  return (
    <span
      className={cn("td-select", className)}
      ref={rootRef}
      onBlur={(event) => {
        const target = event.relatedTarget as Node | null;
        if (!target || (!rootRef.current?.contains(target) && !popupRef.current?.contains(target)))
          setOpen(false);
      }}
    >
      <button
        type="button"
        ref={buttonRef}
        id={id}
        disabled={disabled}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && options[highlight] ? `${listId}-${highlight}` : undefined}
        className={cn("td-input", "td-select__control", open && "is-open")}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={onKeyDown}
      >
        <span className="td-select__value">{current?.label ?? value}</span>
        <ChevronDown size={13} aria-hidden="true" className="td-select__chevron" />
      </button>
      {open && !disabled && position
        ? createPortal(
            <div
              ref={popupRef}
              id={listId}
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
                  id={`${listId}-${index}`}
                  data-option-index={index}
                  tabIndex={-1}
                  aria-selected={option.value === value}
                  className={cn("td-select__option", index === highlight && "is-highlight")}
                  onMouseEnter={() => setHighlight(index)}
                  onMouseDown={(event) => event.preventDefault()}
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
