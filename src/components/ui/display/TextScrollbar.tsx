import {
  useEffect,
  useLayoutEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import "./textScrollbar.css";

interface TextScrollbarProps {
  target: RefObject<HTMLElement | null>;
}

type Gesture =
  | { kind: "thumb"; pointer: number; offset: number }
  | { kind: "track"; pointer: number; clientY: number };

interface TrackScroll {
  direction: -1 | 0 | 1;
  velocity: number;
}

const MIN_THUMB_HEIGHT = 24;
const MIN_VELOCITY = 0.35;
const MAX_VELOCITY = 3.5;

function setScrollTop(element: HTMLElement, top: number) {
  element.scrollTop = top;
}

/** Convert the pointer's distance from the thumb into a direction and pixels per second. */
export function trackScrollVelocity(
  clientY: number,
  railTop: number,
  thumbTop: number,
  thumbHeight: number,
  viewportHeight: number,
): TrackScroll {
  const thumbBottom = thumbTop + thumbHeight;
  if (clientY >= thumbTop && clientY <= thumbBottom) return { direction: 0, velocity: 0 };
  const direction = clientY < thumbTop ? -1 : 1;
  const distance = direction < 0 ? thumbTop - clientY : clientY - thumbBottom;
  const available =
    direction < 0
      ? Math.max(1, thumbTop - railTop)
      : Math.max(1, railTop + viewportHeight - thumbBottom);
  const ratio = Math.max(0, Math.min(1, distance / available));
  return {
    direction,
    velocity: viewportHeight * (MIN_VELOCITY + ratio * (MAX_VELOCITY - MIN_VELOCITY)),
  };
}

/**
 * An overlay scrollbar for text controls. The rail captures presses on its blank
 * area and scrolls continuously, with velocity increasing with pointer distance.
 */
export function TextScrollbar({ target }: TextScrollbarProps) {
  const rail = useRef<HTMLDivElement>(null);
  const thumb = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const updateFrame = useRef<number | null>(null);
  const scrollFrame = useRef<number | null>(null);
  const lastFrame = useRef(0);

  const update = () => {
    const view = target.current,
      track = rail.current,
      handle = thumb.current;
    if (!view || !track || !handle) return;
    const range = view.scrollHeight - view.clientHeight;
    const trackHeight = view.clientHeight;
    const height = Math.min(
      trackHeight,
      Math.max(
        MIN_THUMB_HEIGHT,
        (trackHeight * view.clientHeight) / Math.max(1, view.scrollHeight),
      ),
    );
    track.hidden = range <= 0 || trackHeight === 0;
    track.style.height = `${trackHeight}px`;
    handle.style.height = `${height}px`;
    handle.style.transform = `translateY(${
      range > 0 ? Math.max(0, Math.min(1, view.scrollTop / range)) * (trackHeight - height) : 0
    }px)`;
  };

  const scheduleUpdate = () => {
    if (updateFrame.current !== null) return;
    updateFrame.current = requestAnimationFrame(() => {
      updateFrame.current = null;
      update();
    });
  };

  const stopAutoScroll = () => {
    if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current);
    scrollFrame.current = null;
    lastFrame.current = 0;
  };

  const scrollFromTrack = (clientY: number, elapsed: number) => {
    const element = target.current,
      track = rail.current,
      handle = thumb.current;
    if (!element || !track || !handle) return false;
    const railRect = track.getBoundingClientRect(),
      thumbRect = handle.getBoundingClientRect();
    const { direction, velocity } = trackScrollVelocity(
      clientY,
      railRect.top,
      thumbRect.top,
      thumbRect.height,
      element.clientHeight,
    );
    if (direction === 0) return false;
    const before = element.scrollTop;
    setScrollTop(element, before + (direction * velocity * elapsed) / 1000);
    if (element.scrollTop === before) return false;
    update();
    return true;
  };

  const animate = (time: number) => {
    const current = gesture.current;
    if (!current || current.kind !== "track") {
      scrollFrame.current = null;
      return;
    }
    const elapsed = Math.max(0, Math.min(50, time - lastFrame.current));
    lastFrame.current = time;
    if (!scrollFromTrack(current.clientY, elapsed)) {
      scrollFrame.current = null;
      return;
    }
    scrollFrame.current = requestAnimationFrame(animate);
  };

  const startAutoScroll = () => {
    if (scrollFrame.current !== null) return;
    lastFrame.current = performance.now();
    scrollFrame.current = requestAnimationFrame(animate);
  };

  const endGesture = () => {
    gesture.current = null;
    stopAutoScroll();
    rail.current?.removeAttribute("data-dragging");
    rail.current?.removeAttribute("data-scrolling");
  };

  useEffect(() => {
    const view = target.current;
    if (!view) return;
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleUpdate);
    observer?.observe(view);
    view.addEventListener("scroll", scheduleUpdate, { passive: true });
    view.addEventListener("input", scheduleUpdate);
    update();
    return () => {
      observer?.disconnect();
      view.removeEventListener("scroll", scheduleUpdate);
      view.removeEventListener("input", scheduleUpdate);
      if (updateFrame.current !== null) cancelAnimationFrame(updateFrame.current);
      updateFrame.current = null;
      stopAutoScroll();
    };
    // The target ref is stable for this component's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  useLayoutEffect(() => {
    update();
    // The target ref is stable for this component's lifetime.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  const moveThumb = (clientY: number, offset: number) => {
    const element = target.current,
      track = rail.current,
      handle = thumb.current;
    if (!element || !track || !handle) return;
    const railRect = track.getBoundingClientRect(),
      thumbRect = handle.getBoundingClientRect();
    const travel = railRect.height - thumbRect.height;
    if (travel <= 0) return;
    setScrollTop(
      element,
      ((clientY - railRect.top - offset) / travel) * (element.scrollHeight - element.clientHeight),
    );
    update();
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.isPrimary === false) return;
    const track = rail.current,
      handle = thumb.current;
    if (!track || !handle) return;
    event.preventDefault();
    event.stopPropagation();
    const thumbRect = handle.getBoundingClientRect();
    if (event.clientY >= thumbRect.top && event.clientY <= thumbRect.top + thumbRect.height) {
      gesture.current = {
        kind: "thumb",
        pointer: event.pointerId,
        offset: event.clientY - thumbRect.top,
      };
      track.dataset.dragging = "true";
    } else {
      gesture.current = { kind: "track", pointer: event.pointerId, clientY: event.clientY };
      track.dataset.scrolling = "true";
      // A press still moves by an amount proportional to its distance from the thumb.
      scrollFromTrack(event.clientY, 80);
      startAutoScroll();
    }
    try {
      track.setPointerCapture?.(event.pointerId);
    } catch {
      /* Pointer capture is optional; React still receives events from the rail. */
    }
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const current = gesture.current;
    if (!current || current.pointer !== event.pointerId) return;
    if ((event.buttons & 1) === 0) {
      endGesture();
      return;
    }
    if (current.kind === "thumb") {
      moveThumb(event.clientY, current.offset);
      return;
    }
    current.clientY = event.clientY;
    startAutoScroll();
  };

  return (
    <div
      className="td-text-scrollbar"
      ref={rail}
      hidden
      aria-hidden="true"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endGesture}
      onPointerCancel={endGesture}
      onLostPointerCapture={endGesture}
    >
      <div className="td-text-scrollbar__thumb" ref={thumb} />
    </div>
  );
}
