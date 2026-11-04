import { useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

export function FileSplitView({
  storageKey,
  left,
  right,
}: {
  storageKey: string;
  left: ReactNode;
  right: ReactNode;
}) {
  const { t } = useTranslation();
  const root = useRef<HTMLDivElement>(null);
  const drag = useRef<number | null>(null);
  const [ratio, setRatio] = useState(() => {
    try {
      const stored = Number(localStorage.getItem(storageKey) ?? 50);
      return Number.isFinite(stored) ? Math.max(20, Math.min(80, stored)) : 50;
    } catch {
      return 50;
    }
  });
  const latest = useRef(ratio);
  const change = (next: number, persist = true) => {
    latest.current = Math.max(20, Math.min(80, next));
    setRatio(latest.current);
    if (persist) {
      try {
        localStorage.setItem(storageKey, String(latest.current));
      } catch {
        /* Optional preference. */
      }
    }
  };
  return (
    <div
      className="sftp-panes sftp-panes--resizable"
      ref={root}
      style={{ gridTemplateColumns: `minmax(0, ${ratio}fr) 6px minmax(0, ${100 - ratio}fr)` }}
    >
      {left}
      <div
        className="sftp-splitter"
        role="separator"
        tabIndex={0}
        aria-label={t("sftp.resizePanels")}
        aria-orientation="vertical"
        aria-valuemin={20}
        aria-valuemax={80}
        aria-valuenow={Math.round(ratio)}
        onDoubleClick={() => change(50)}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          drag.current = event.pointerId;
          event.currentTarget.setPointerCapture?.(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (drag.current !== event.pointerId || !root.current) return;
          const rect = root.current.getBoundingClientRect();
          if (rect.width > 0) change(((event.clientX - rect.left) / rect.width) * 100, false);
        }}
        onPointerUp={(event) => {
          if (drag.current !== event.pointerId) return;
          drag.current = null;
          change(latest.current);
          if (event.currentTarget.hasPointerCapture?.(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onLostPointerCapture={() => {
          if (drag.current !== null) {
            drag.current = null;
            change(latest.current);
          }
        }}
        onPointerCancel={() => {
          drag.current = null;
          change(latest.current);
        }}
        onKeyDown={(event) => {
          const next =
            event.key === "ArrowLeft"
              ? ratio - 5
              : event.key === "ArrowRight"
                ? ratio + 5
                : event.key === "Home"
                  ? 20
                  : event.key === "End"
                    ? 80
                    : null;
          if (next !== null) {
            event.preventDefault();
            event.stopPropagation();
            change(next);
          }
        }}
      />
      {right}
    </div>
  );
}
