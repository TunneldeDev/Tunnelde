interface MenuKeyboardEvent {
  key: string;
  keyCode?: number;
  isComposing?: boolean;
  nativeEvent?: { isComposing?: boolean };
  preventDefault: () => void;
  stopPropagation: () => void;
}

function enabledItems(menu: HTMLElement): HTMLButtonElement[] {
  return Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'));
}

export function focusMenuItem(menu: HTMLElement | null, last = false): void {
  if (!menu) return;
  const items = enabledItems(menu);
  (last ? items.at(-1) : items[0])?.focus({ preventScroll: true });
  if (!items.length) menu.focus({ preventScroll: true });
}

/** Separators and disabled actions never participate in keyboard navigation. */
export function handleMenuKeyDown(
  event: MenuKeyboardEvent,
  menu: HTMLElement | null,
  close: () => void,
): void {
  if (!menu || event.isComposing || event.nativeEvent?.isComposing || event.keyCode === 229) return;
  if (event.key === "Escape" || event.key === "Tab") {
    if (event.key === "Escape") event.preventDefault();
    event.stopPropagation();
    close();
    return;
  }
  const items = enabledItems(menu);
  const active = items.findIndex((item) => item === document.activeElement);
  if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
    event.preventDefault();
    event.stopPropagation();
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : active < 0
            ? event.key === "ArrowUp"
              ? items.length - 1
              : 0
            : (active + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
    items[next]?.focus({ preventScroll: true });
    items[next]?.scrollIntoView?.({ block: "nearest" });
  } else if ((event.key === "Enter" || event.key === " ") && active >= 0) {
    event.preventDefault();
    event.stopPropagation();
    items[active]?.click();
  }
}
