import { useLayoutEffect, useRef } from "react";

/** A public component moves one host-owned DOM surface without remounting its owner. */
export function createPersistentSurface() {
  const container = document.createElement("div");
  container.style.display = "contents";
  let owner: HTMLElement | null = null;
  let focused: HTMLElement | null = null;
  function Mount() {
    const ref = useRef<HTMLDivElement>(null);
    useLayoutEffect(() => {
      const target = ref.current!;
      if (owner) throw new Error("plugin.frontend.duplicateSurface");
      owner = target;
      target.append(container);
      if (focused && container.contains(focused)) focused.focus({ preventScroll: true });
      focused = null;
      return () => {
        if (
          document.activeElement instanceof HTMLElement &&
          container.contains(document.activeElement)
        )
          focused = document.activeElement;
        if (owner === target) {
          owner = null;
          container.remove();
        }
      };
    }, []);
    return <div ref={ref} style={{ display: "contents" }} />;
  }
  return Object.freeze({ container, Mount });
}
