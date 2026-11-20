import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { useTranslation } from "react-i18next";
import type { FloatingRect } from "@/lib/layout/floatingPanel";
import { useFloatingPanel } from "./useFloatingPanel";
import "./workbenchPanel.css";

type Geometry = ReturnType<typeof useFloatingPanel>;

/** Shared surface/geometry for sidebar panels and ordinary workspace pages.
 * The caller owns lifetime and chrome actions; moving a frame never owns SSH. */
export function PanelFrame({
  floating = false,
  location = "workspace",
  label,
  bounds = null,
  onBounds,
  frameRef,
  header,
  children,
  onEscape,
  panelId,
}: {
  floating?: boolean;
  location?: string;
  label: string;
  bounds?: FloatingRect | null;
  onBounds: (bounds: FloatingRect | null) => void;
  frameRef?: RefObject<HTMLElement | null>;
  header: (geometry: Geometry) => ReactNode;
  children: ReactNode;
  onEscape?: () => void;
  panelId?: string;
}) {
  const ownRef = useRef<HTMLElement>(null);
  const ref = frameRef ?? ownRef;
  const { t } = useTranslation();
  const geometry = useFloatingPanel(ref, floating ? bounds : null, onBounds);
  useEffect(() => {
    const element = ref.current;
    if (!floating || !element || !onEscape) return;
    const dismiss = (event: globalThis.KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.key !== "Escape" ||
        document.querySelector(
          '[role="dialog"][aria-modal="true"], .td-menu, .context-menu, .td-tooltip',
        )
      )
        return;
      event.stopPropagation();
      onEscape();
    };
    // Retained page portals have a separate React owner. Listen on their actual
    // surface, otherwise their Escape bypasses this frame's React event tree.
    element.addEventListener("keydown", dismiss);
    return () => element.removeEventListener("keydown", dismiss);
  }, [floating, onEscape, ref]);
  return (
    <section
      ref={ref}
      className={`workbench-panel is-${location}${floating ? " workbench-panel--floating" : ""}`}
      data-workbench-panel={panelId}
      data-drag-hit-test={floating ? "exclude" : undefined}
      role={floating ? "dialog" : "region"}
      aria-modal={floating ? "false" : undefined}
      aria-label={label}
    >
      {header(geometry)}
      <div className="workbench-panel__body">{children}</div>
      {floating &&
        (["n", "e", "s", "w", "ne", "nw", "se", "sw"] as const).map((edge) => (
          <div
            key={edge}
            className={`workbench-panel__resize workbench-panel__resize--${edge}`}
            {...geometry.handle(edge)}
            {...(edge === "se"
              ? { role: "button", tabIndex: 0, "aria-label": t("panels.resizeHint") }
              : { "aria-hidden": true })}
          />
        ))}
    </section>
  );
}
