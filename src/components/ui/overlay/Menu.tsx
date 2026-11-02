import { MoreHorizontal } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { IconButton } from "@/components/ui/form/Button";
import { cn } from "@/lib/text/format";
import { focusMenuItem, handleMenuKeyDown } from "./menuKeyboard";
import { MenuItems } from "./MenuItems";
import type { MenuAction } from "./menuTypes";
import "@/styles/menus.css";

export type { MenuAction } from "./menuTypes";

interface MenuProps {
  label: string;
  items: MenuAction[];
  trigger?: ReactNode;
  className?: string;
  menuClassName?: string;
  disabled?: boolean;
}

const MENU_WIDTH = 184;

export function Menu({ label, items, trigger, className, menuClassName, disabled }: MenuProps) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const openLast = useRef(false);
  const menuId = useId();
  if (disabled && open) setOpen(false);
  const close = useCallback((restoreFocus = true) => {
    setOpen(false);
    setPosition(null);
    if (restoreFocus) buttonRef.current?.focus({ preventScroll: true });
  }, []);

  useLayoutEffect(() => {
    if (!open || !buttonRef.current) {
      return;
    }
    const rect = buttonRef.current.getBoundingClientRect();
    const measured = menuRef.current?.getBoundingClientRect();
    const height = measured?.height ?? 0;
    const width = measured?.width || MENU_WIDTH;
    const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
    const top =
      rect.bottom + height + 8 > window.innerHeight
        ? Math.max(8, rect.top - height - 4)
        : Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - height - 8));
    setPosition({ top, left });
  }, [open, items]);

  useLayoutEffect(() => {
    if (open && position) focusMenuItem(menuRef.current, openLast.current);
  }, [open, position]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement;
      if (buttonRef.current?.contains(target) || menuRef.current?.contains(target)) {
        return;
      }
      close(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      handleMenuKeyDown(event, menuRef.current, () => close());
    };
    const dismiss = () => close(false);
    const onScroll = (event: Event) => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      dismiss();
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open, close]);

  return (
    <>
      <IconButton
        label={label}
        size="sm"
        ref={buttonRef}
        className={cn("td-menu__trigger", trigger && "td-menu__trigger--custom", className)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={(event) => {
          event.stopPropagation();
          if (open) close();
          else {
            openLast.current = false;
            setOpen(true);
          }
        }}
        onKeyDown={(event) => {
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          event.stopPropagation();
          openLast.current = event.key === "ArrowUp";
          if (open) focusMenuItem(menuRef.current, openLast.current);
          else setOpen(true);
        }}
      >
        {trigger ?? <MoreHorizontal size={14} />}
      </IconButton>
      {open && !disabled
        ? createPortal(
            <div
              ref={menuRef}
              id={menuId}
              tabIndex={-1}
              aria-label={label}
              className={cn("td-menu", menuClassName)}
              role="menu"
              onKeyDown={(event) => handleMenuKeyDown(event, menuRef.current, () => close())}
              style={{
                top: position?.top ?? 0,
                left: position?.left ?? 0,
                visibility: position ? "visible" : "hidden",
              }}
            >
              <MenuItems
                items={items}
                onSelect={(item) => {
                  close();
                  item.onSelect();
                }}
              />
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
