import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import "./tooltip.css";

/** Non-interactive help. The child supplies a focusable trigger, never a second tab stop. */
export function Tooltip({
  children,
  content,
}: {
  children: (descriptionId: string) => ReactNode;
  content: ReactNode;
}) {
  const id = useId();
  const anchor = useRef<HTMLSpanElement>(null);
  const bubble = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);
  const [open, setOpen] = useState(false);
  const clearTimer = () => window.clearTimeout(timer.current);
  const show = () => {
    clearTimer();
    document.dispatchEvent(new CustomEvent("td-tooltip-open", { detail: id }));
    setOpen(true);
  };
  const leave = () => {
    clearTimer();
    if (anchor.current?.contains(document.activeElement)) return;
    timer.current = window.setTimeout(() => setOpen(false), 100);
  };
  useEffect(() => () => window.clearTimeout(timer.current), []);
  useEffect(() => {
    const otherOpened = (event: Event) => {
      if ((event as CustomEvent<string>).detail === id) return;
      clearTimer();
      setOpen(false);
    };
    document.addEventListener("td-tooltip-open", otherOpened);
    return () => document.removeEventListener("td-tooltip-open", otherOpened);
  }, [id]);
  useLayoutEffect(() => {
    if (!open) return;
    const position = () => {
      const trigger = anchor.current?.getBoundingClientRect();
      const tip = bubble.current;
      if (!trigger || !tip) return;
      const gap = 8;
      const width = tip.getBoundingClientRect().width;
      const height = tip.getBoundingClientRect().height;
      const left = Math.max(gap, Math.min(trigger.left, window.innerWidth - width - gap));
      const below = trigger.bottom + gap;
      const top = below + height <= window.innerHeight - gap ? below : trigger.top - height - gap;
      tip.style.left = `${left}px`;
      tip.style.top = `${Math.max(gap, top)}px`;
    };
    position();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(position) : null;
    if (anchor.current) observer?.observe(anchor.current);
    if (bubble.current) observer?.observe(bubble.current);
    window.addEventListener("resize", position);
    document.addEventListener("scroll", position, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", position);
      document.removeEventListener("scroll", position, true);
    };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !anchor.current?.contains(event.target) &&
        !bubble.current?.contains(event.target)
      ) {
        clearTimer();
        setOpen(false);
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      const dialogs = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
      const topDialog = dialogs[dialogs.length - 1];
      if (topDialog && !topDialog.contains(anchor.current)) {
        setOpen(false);
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      clearTimer();
      setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("keydown", escape, true);
    };
  }, [open]);
  return (
    <span
      className="td-tooltip-anchor"
      ref={anchor}
      onPointerEnter={(event) => {
        if (event.pointerType === "touch") return;
        clearTimer();
        timer.current = window.setTimeout(show, 350);
      }}
      onPointerLeave={leave}
      onFocus={show}
      onBlur={(event) => {
        if (event.relatedTarget instanceof Node && anchor.current?.contains(event.relatedTarget))
          return;
        clearTimer();
        setOpen(false);
      }}
      onClick={show}
    >
      {children(id)}
      {/* A persistent description also works before the visual tooltip opens. */}
      <span id={id} className="td-sr-only">
        {content}
      </span>
      {open &&
        createPortal(
          <div
            className="td-tooltip"
            role="tooltip"
            ref={bubble}
            onPointerEnter={clearTimer}
            onPointerLeave={leave}
          >
            {content}
          </div>,
          document.body,
        )}
    </span>
  );
}
