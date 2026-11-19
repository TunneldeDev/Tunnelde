import {
  createContext,
  memo,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  splitIntersections,
  resizeIntersection,
  type ResizeParticipant,
} from "@/lib/layout/intersections";
import type { SplitDirection } from "@/lib/layout/types";
import { usePointerDrag } from "@/lib/session/usePointerDrag";
import { useBackgroundGuard } from "@/lib/session/viewState";
import "./splitGeometry.css";

export type SplitResizeBatch = (ratios: Record<string, number>) => void;
export interface SplitGeometryEntry {
  id: string;
  splitId: string;
  element: HTMLElement;
  separator: HTMLElement;
  direction: SplitDirection;
  min: number;
  max: number;
  reset: number;
  ratio: () => number;
  preview: (ratio: number) => void;
  commit: (ratio: number) => void;
  batch?: SplitResizeBatch;
}
function createRegistry() {
  const entries = new Map<string, SplitGeometryEntry>();
  const listeners = new Set<() => void>();
  let frame: number | null = null;
  let complex = false;
  const invalidate = () => {
    if (frame !== null || !listeners.size || (entries.size < 2 && !complex)) return;
    complex = entries.size >= 2;
    frame = requestAnimationFrame(() => {
      frame = null;
      for (const listener of listeners) listener();
    });
  };
  return {
    entries,
    invalidate,
    subscribe(listener: () => void) {
      listeners.add(listener);
      invalidate();
      return () => {
        listeners.delete(listener);
        if (!listeners.size && frame !== null) {
          cancelAnimationFrame(frame);
          frame = null;
        }
      };
    },
    register(entry: SplitGeometryEntry) {
      entries.set(entry.id, entry);
      const observer =
        typeof ResizeObserver !== "undefined" ? new ResizeObserver(invalidate) : null;
      observer?.observe(entry.element);
      observer?.observe(entry.separator);
      invalidate();
      return () => {
        observer?.disconnect();
        entries.delete(entry.id);
        invalidate();
      };
    },
  };
}
const SplitGeometryContext = createContext<ReturnType<typeof createRegistry> | null>(null);
export const useSplitGeometry = () => useContext(SplitGeometryContext);

/** No layout wrapper: the overlay lives inside the outer registered split surface. */
export function SplitGeometryScope({ children }: { children: ReactNode }) {
  const [registry] = useState(createRegistry);
  return (
    <SplitGeometryContext.Provider value={registry}>
      {children}
      <Intersections registry={registry} />
    </SplitGeometryContext.Provider>
  );
}

const Intersections = memo(function Intersections({
  registry,
}: {
  registry: ReturnType<typeof createRegistry>;
}) {
  const [, refresh] = useState(0);
  useLayoutEffect(() => registry.subscribe(() => refresh((value) => value + 1)), [registry]);
  useEffect(() => {
    const invalidate = registry.invalidate;
    window.addEventListener("resize", invalidate);
    window.addEventListener("scroll", invalidate, true);
    return () => {
      window.removeEventListener("resize", invalidate);
      window.removeEventListener("scroll", invalidate, true);
    };
  }, [registry]);
  const entries = [...registry.entries.values()].filter((entry) => entry.element.isConnected);
  const roots = entries.filter(
    (entry) => !entries.some((other) => other !== entry && other.element.contains(entry.element)),
  );
  return (
    <>
      {roots.map((entry) => (
        <IntersectionSurface
          key={entry.id}
          registry={registry}
          root={entry.element}
          entries={entries.filter((other) => entry.element.contains(other.element))}
        />
      ))}
    </>
  );
});
function IntersectionSurface({
  registry,
  root,
  entries,
}: {
  registry: ReturnType<typeof createRegistry>;
  root: HTMLElement;
  entries: SplitGeometryEntry[];
}) {
  const { t } = useTranslation();
  const [active, setActive] = useState(false);
  useBackgroundGuard(active);
  const drag = usePointerDrag();
  const rootBounds = root.getBoundingClientRect();
  const points = splitIntersections(
    entries.map((entry) => {
      const bounds = entry.separator.getBoundingClientRect();
      return {
        id: entry.id,
        direction: entry.direction,
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
      };
    }),
  );
  const commit = (values: Record<string, number>) => {
    const batches = new Map<SplitResizeBatch, Record<string, number>>();
    for (const [id, ratio] of Object.entries(values)) {
      const entry = registry.entries.get(id);
      if (!entry || entry.ratio() === ratio) continue;
      if (entry.batch) {
        const batch = batches.get(entry.batch) ?? {};
        batch[entry.splitId] = ratio;
        batches.set(entry.batch, batch);
      } else entry.commit(ratio);
    }
    for (const [batch, ratios] of batches) batch(ratios);
    registry.invalidate();
  };
  const participants = (ids: string[]): ResizeParticipant[] =>
    ids.flatMap((id) => {
      const entry = registry.entries.get(id);
      if (!entry) return [];
      const bounds = entry.element.getBoundingClientRect(),
        separator = entry.separator.getBoundingClientRect();
      return [
        {
          id,
          direction: entry.direction,
          min: entry.min,
          max: entry.max,
          ratio: entry.ratio(),
          size:
            entry.direction === "row"
              ? bounds.width - separator.width
              : bounds.height - separator.height,
        },
      ];
    });
  return createPortal(
    <div className="td-split-intersections">
      {points.map((point) => (
        <button
          key={point.id}
          type="button"
          className="td-split-intersection"
          data-split-intersection={point.id}
          aria-label={t("panels.resizeIntersection")}
          title={t("panels.resizeIntersectionHint")}
          style={{
            left: point.x - rootBounds.x + root.scrollLeft,
            top: point.y - rootBounds.y + root.scrollTop,
          }}
          onDoubleClick={() =>
            commit(
              Object.fromEntries(point.splits.map((id) => [id, registry.entries.get(id)!.reset])),
            )
          }
          onKeyDown={(event) => {
            if (
              event.nativeEvent.isComposing ||
              !["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home"].includes(event.key)
            )
              return;
            event.preventDefault();
            event.stopPropagation();
            if (event.key === "Home") {
              commit(
                Object.fromEntries(point.splits.map((id) => [id, registry.entries.get(id)!.reset])),
              );
              return;
            }
            const step = event.shiftKey ? 1 : 10;
            commit(
              resizeIntersection(
                participants(point.splits),
                event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0,
                event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0,
              ),
            );
          }}
          onPointerDown={(event) => {
            const items = participants(point.splits);
            if (event.button !== 0 || active || !items.length) return;
            const owners = new Map(items.map((item) => [item.id, registry.entries.get(item.id)!]));
            const stale = () =>
              items.some((item) => {
                const owner = owners.get(item.id)!;
                return (
                  registry.entries.get(item.id) !== owner ||
                  !owner.element.isConnected ||
                  !root.contains(owner.element) ||
                  owner.ratio() !== item.ratio
                );
              });
            const origin = { x: event.clientX, y: event.clientY };
            let values: Record<string, number> | null = null;
            const before = {
              cursor: document.body.style.cursor,
              userSelect: document.body.style.userSelect,
            };
            document.body.style.cursor = "move";
            document.body.style.userSelect = "none";
            setActive(true);
            const finish = (cancel: boolean) => {
              cancel ||= stale();
              if (cancel)
                for (const item of items) {
                  const entry = registry.entries.get(item.id);
                  if (entry) entry.preview(entry.ratio());
                }
              else if (values) commit(values);
              document.body.style.cursor = before.cursor;
              document.body.style.userSelect = before.userSelect;
              setActive(false);
              registry.invalidate();
            };
            drag(event, {
              move: (next) => {
                if (stale()) return;
                values = resizeIntersection(
                  items,
                  next.clientX - origin.x,
                  next.clientY - origin.y,
                );
                for (const [id, ratio] of Object.entries(values))
                  registry.entries.get(id)?.preview(ratio);
              },
              commit: () => finish(false),
              cancel: () => finish(true),
            });
          }}
        />
      ))}
    </div>,
    root,
  );
}
