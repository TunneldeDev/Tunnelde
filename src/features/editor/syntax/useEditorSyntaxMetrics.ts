import { useCallback, useEffect, useLayoutEffect, useState, type RefObject } from "react";
import type { EditorSyntaxMetrics } from "./EditorSyntaxOverlay";

const FALLBACK: EditorSyntaxMetrics = {
  font: "var(--td-mono)",
  fontSize: "var(--td-mono-size)",
  lineHeight: "1.55",
  tabSize: "4",
  wordWrap: false,
  padding: "10px 12px",
  paddingInline: 24,
  contentWidth: 0,
  border: "0",
  scrollbarWidth: 0,
  scrollbarHeight: 0,
  scrollTop: 0,
  scrollLeft: 0,
};

function measure(
  element: HTMLTextAreaElement,
  previous: EditorSyntaxMetrics,
): EditorSyntaxMetrics {
  const style = getComputedStyle(element);
  return {
    font: style.fontFamily,
    fontSize: style.fontSize,
    lineHeight: style.lineHeight,
    tabSize: style.tabSize || previous.tabSize,
    wordWrap: element.wrap === "soft",
    padding: style.padding,
    paddingInline: (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0),
    contentWidth:
      element.offsetWidth -
      (parseFloat(style.borderLeftWidth) || 0) -
      (parseFloat(style.borderRightWidth) || 0) -
      Math.max(0, element.offsetWidth - element.clientWidth),
    border: style.border,
    scrollbarWidth: Math.max(
      0,
      element.offsetWidth -
        element.clientWidth -
        (parseFloat(style.borderLeftWidth) || 0) -
        (parseFloat(style.borderRightWidth) || 0),
    ),
    scrollbarHeight: Math.max(
      0,
      element.offsetHeight -
        element.clientHeight -
        (parseFloat(style.borderTopWidth) || 0) -
        (parseFloat(style.borderBottomWidth) || 0),
    ),
    scrollTop: element.scrollTop,
    scrollLeft: element.scrollLeft,
  };
}

export function useEditorSyntaxMetrics(
  target: RefObject<HTMLTextAreaElement | null>,
  dependencies: readonly unknown[],
) {
  const [metrics, setMetrics] = useState<EditorSyntaxMetrics>(FALLBACK);
  const sync = useCallback(() => {
    const element = target.current;
    if (!element) return;
    setMetrics((previous) => {
      const next = measure(element, previous);
      return Object.keys(next).every(
        (key) => next[key as keyof EditorSyntaxMetrics] === previous[key as keyof EditorSyntaxMetrics],
      )
        ? previous
        : next;
    });
  }, [target]);

  useLayoutEffect(sync, [sync, ...dependencies]);

  useEffect(() => {
    const element = target.current;
    if (!element) return;
    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => sync());
    observer?.observe(element);
    const onScroll = () => sync();
    const onResize = () => sync();
    element.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onResize);
    void document.fonts?.ready.then(sync).catch(() => {});
    return () => {
      observer?.disconnect();
      element.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onResize);
    };
  }, [sync, target]);

  return { metrics, sync };
}
