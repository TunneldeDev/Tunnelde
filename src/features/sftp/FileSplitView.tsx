import { useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { usePointerDrag } from "@/lib/session/usePointerDrag";

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
  const beginResize = usePointerDrag();
  const [ratio, setRatio] = useState(() => {
    try {
      const stored = Number(localStorage.getItem(storageKey) ?? 50);
      return Number.isFinite(stored) ? Math.max(20, Math.min(80, stored)) : 50;
    } catch {
      return 50;
    }
  });
  const savedRatio = useRef(ratio);
  const change = (next: number) => {
    const clamped = Math.max(20, Math.min(80, next));
    savedRatio.current = clamped;
    setRatio(clamped);
    try {
      localStorage.setItem(storageKey, String(clamped));
    } catch {
      /* Optional preference. */
    }
  };
  const grid = (value: number) => `minmax(0, ${value}fr) 6px minmax(0, ${100 - value}fr)`;
  return (
    <div
      className="sftp-panes sftp-panes--resizable"
      ref={root}
      style={{ gridTemplateColumns: grid(ratio) }}
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
          const panel = root.current;
          if (!panel) return;
          const handle = event.currentTarget;
          const origin = event.clientX;
          let latest = ratio;
          const preview = (value: number) => {
            panel.style.gridTemplateColumns = grid(value);
            handle.setAttribute("aria-valuenow", String(Math.round(value)));
          };
          beginResize(event, {
            move: (next) => {
              const rect = panel.getBoundingClientRect();
              const width = rect.width - handle.getBoundingClientRect().width;
              if (width <= 0 || !Number.isFinite(next.clientX)) return;
              latest = Math.max(20, Math.min(80, ratio + ((next.clientX - origin) / width) * 100));
              preview(latest);
            },
            commit: () => change(latest),
            cancel: () => preview(savedRatio.current),
          });
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
