import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";

import { useContextMenu } from "@/store/contextMenu";
import { focusMenuItem, handleMenuKeyDown } from "./menuKeyboard";
import "@/styles/menus.css";

export function ContextMenuHost() {
  const menu = useContextMenu((state) => state.menu);
  const close = useContextMenu((state) => state.close);
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x: 0, y: 0 });

  useLayoutEffect(() => {
    if (!menu) {
      return;
    }
    const element = ref.current;
    if (!element) {
      setPosition({ x: menu.x, y: menu.y });
      return;
    }
    const rect = element.getBoundingClientRect();
    const x = Math.min(menu.x, window.innerWidth - rect.width - 8);
    const y = Math.min(menu.y, window.innerHeight - rect.height - 8);
    setPosition({ x: Math.max(8, x), y: Math.max(8, y) });
    focusMenuItem(element);
  }, [menu]);

  useEffect(() => {
    if (!menu) {
      return;
    }
    const onPointerDown = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) {
        close(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      handleMenuKeyDown(event, ref.current, () => close());
    };
    const dismiss = () => close(false);
    const onScroll = (event: Event) => {
      if (event.target instanceof Node && ref.current?.contains(event.target)) return;
      dismiss();
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [menu, close]);

  if (!menu) {
    return null;
  }

  return (
    <div
      ref={ref}
      className="context-menu"
      role="menu"
      tabIndex={-1}
      style={{ left: position.x, top: position.y }}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => handleMenuKeyDown(event, ref.current, () => close())}
    >
      {menu.items.map((item, index) => (
        <Fragment key={index}>
          {index > 0 && item.separatorBefore ? (
            <div className="td-menu__separator" role="separator" />
          ) : null}
          <button
            type="button"
            role="menuitem"
            className="context-menu__item"
            data-danger={item.danger ? "true" : undefined}
            disabled={item.disabled}
            tabIndex={-1}
            onClick={() => {
              close();
              item.onSelect();
            }}
          >
            {item.label}
          </button>
        </Fragment>
      ))}
    </div>
  );
}
