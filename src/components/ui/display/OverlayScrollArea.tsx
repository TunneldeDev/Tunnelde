import { useEffect, useRef, type HTMLAttributes, type PointerEvent } from "react";
import "./overlayScrollArea.css";

/** Native vertical scrolling with a thumb that overlays, rather than narrows, the content. */
export function OverlayScrollArea({
  className = "",
  children,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const thumb = useRef<HTMLDivElement>(null);
  const drag = useRef<{ pointer: number; offset: number } | null>(null);

  useEffect(() => {
    const view = viewport.current!,
      rail = track.current!,
      handle = thumb.current!;
    let frame = 0;
    const update = () => {
      frame = 0;
      const range = view.scrollHeight - view.clientHeight;
      const trackHeight = view.clientHeight;
      const height = Math.min(
        trackHeight,
        Math.max(24, (trackHeight * view.clientHeight) / Math.max(1, view.scrollHeight)),
      );
      rail.hidden = range <= 0 || view.clientHeight === 0;
      handle.style.height = `${height}px`;
      handle.style.transform = `translateY(${range > 0 ? Math.max(0, Math.min(1, view.scrollTop / range)) * (trackHeight - height) : 0}px)`;
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    observer?.observe(view);
    observer?.observe(content.current!);
    const wheel = (event: WheelEvent) => {
      const unit = event.deltaMode === 2 ? view.clientHeight : event.deltaMode === 1 ? 16 : 1;
      view.scrollTop += event.deltaY * unit;
      event.preventDefault();
    };
    rail.addEventListener("wheel", wheel, { passive: false });
    view.addEventListener("scroll", schedule, { passive: true });
    update();
    return () => {
      observer?.disconnect();
      rail.removeEventListener("wheel", wheel);
      view.removeEventListener("scroll", schedule);
      cancelAnimationFrame(frame);
    };
  }, []);

  const move = (event: PointerEvent<HTMLDivElement>, offset: number) => {
    const view = viewport.current!,
      rail = track.current!,
      handle = thumb.current!;
    const travel = rail.clientHeight - handle.offsetHeight;
    if (travel > 0)
      view.scrollTop =
        ((event.clientY - rail.getBoundingClientRect().top - offset) / travel) *
        (view.scrollHeight - view.clientHeight);
  };
  const endDrag = () => {
    drag.current = null;
    track.current?.removeAttribute("data-dragging");
  };

  return (
    <div className={`td-scroll-area ${className}`}>
      <div
        {...props}
        className="td-scroll-area__viewport"
        ref={viewport}
        tabIndex={props.tabIndex ?? 0}
      >
        <div className="td-scroll-area__content" ref={content}>
          {children}
        </div>
      </div>
      <div
        className="td-scroll-area__track"
        ref={track}
        hidden
        aria-hidden="true"
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          const rect = thumb.current!.getBoundingClientRect();
          const offset =
            event.target === thumb.current ? event.clientY - rect.top : rect.height / 2;
          drag.current = { pointer: event.pointerId, offset };
          event.currentTarget.dataset.dragging = "true";
          event.currentTarget.setPointerCapture(event.pointerId);
          move(event, offset);
        }}
        onPointerMove={(event) => {
          if (drag.current?.pointer === event.pointerId) move(event, drag.current.offset);
        }}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
      >
        <div className="td-scroll-area__thumb" ref={thumb} />
      </div>
    </div>
  );
}
