// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { MoreHorizontal } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { IconButton } from "@/components/ui/form/Button";
import { cn } from "@/lib/text/format";

export interface MenuAction {
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}

interface MenuProps {
  label: string;
  items: MenuAction[];
}

const MENU_WIDTH = 184;
const ITEM_HEIGHT = 30;

export function Menu({ label, items }: MenuProps) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => {
    setOpen(false);
    setPosition(null);
  }, []);

  useLayoutEffect(() => {
    if (!open || !buttonRef.current) {
      return;
    }
    const rect = buttonRef.current.getBoundingClientRect();
    const height = items.length * ITEM_HEIGHT + 8;
    const left = Math.min(Math.max(8, rect.right - MENU_WIDTH), window.innerWidth - MENU_WIDTH - 8);
    const top =
      rect.bottom + height + 8 > window.innerHeight
        ? Math.max(8, rect.top - height - 4)
        : rect.bottom + 4;
    setPosition({ top, left });
  }, [open, items.length]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement;
      if (buttonRef.current?.contains(target) || target.closest(".td-menu")) {
        return;
      }
      close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open, close]);

  return (
    <>
      <IconButton
        label={label}
        size="sm"
        ref={buttonRef}
        className="td-menu__trigger"
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
      >
        <MoreHorizontal size={14} />
      </IconButton>
      {open && position
        ? createPortal(
            <div className="td-menu" role="menu" style={{ top: position.top, left: position.left }}>
              {items.map((item) => (
                <button
                  key={item.label}
                  type="button"
                  role="menuitem"
                  disabled={item.disabled}
                  className={cn("td-menu__item", item.danger && "is-danger")}
                  onClick={(event) => {
                    event.stopPropagation();
                    close();
                    item.onSelect();
                  }}
                >
                  {item.icon ? <span className="td-menu__icon">{item.icon}</span> : null}
                  {item.label}
                </button>
              ))}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
