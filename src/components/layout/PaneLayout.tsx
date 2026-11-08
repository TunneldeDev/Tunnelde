import { useLayoutEffect, useRef, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";

import { PaneView } from "@/components/layout/PaneView";
import { useWorkspace, visibleWorkspaceLayout, type WorkspaceLayout } from "@/store/workspace";
import { usePointerDrag } from "@/lib/session/usePointerDrag";

function LayoutNode({ node }: { node: WorkspaceLayout }) {
  const panes = useWorkspace((state) => state.panes);
  const activePaneId = useWorkspace((state) => state.activePaneId);
  if (node.kind === "pane") {
    const pane = panes.find((item) => item.id === node.paneId);
    return pane ? <PaneView pane={pane} active={pane.id === activePaneId} /> : null;
  }
  return <SplitLayout key={`${node.id}:${node.direction}`} node={node} />;
}

function SplitLayout({ node }: { node: Extract<WorkspaceLayout, { kind: "split" }> }) {
  const { t } = useTranslation();
  const resize = useWorkspace((state) => state.resizeSplit);
  const container = useRef<HTMLDivElement>(null);
  const beginResize = usePointerDrag();
  const savedRatio = useRef(node.ratio);
  useLayoutEffect(() => {
    savedRatio.current = node.ratio;
  }, [node.ratio]);
  const horizontal = node.direction === "row";
  return (
    <div
      ref={container}
      className="pane-layout"
      style={
        {
          "--td-split-ratio": node.ratio,
          display: "flex",
          flexDirection: node.direction,
          flex: "1 1 0",
          minWidth: 0,
          minHeight: 0,
          overflow: "hidden",
        } as CSSProperties
      }
    >
      <div
        className="pane-layout__child"
        style={{
          display: "flex",
          flex: "var(--td-split-ratio) 1 0px",
          minWidth: 0,
          minHeight: 0,
          overflow: "hidden",
        }}
      >
        <LayoutNode node={node.first} />
      </div>
      <div
        role="separator"
        tabIndex={0}
        aria-label={t("tab.resizeGroup")}
        aria-orientation={horizontal ? "vertical" : "horizontal"}
        aria-valuemin={15}
        aria-valuemax={85}
        aria-valuenow={Math.round(node.ratio * 100)}
        style={{
          flex: "0 0 4px",
          cursor: horizontal ? "col-resize" : "row-resize",
          background: "var(--td-border)",
          touchAction: "none",
        }}
        onPointerDown={(event) => {
          const panel = container.current;
          if (!panel) return;
          const handle = event.currentTarget;
          const origin = horizontal ? event.clientX : event.clientY;
          let latest = node.ratio;
          const preview = (ratio: number) => {
            panel.style.setProperty("--td-split-ratio", String(ratio));
            handle.setAttribute("aria-valuenow", String(Math.round(ratio * 100)));
          };
          beginResize(event, {
            move: (next) => {
              const rect = panel.getBoundingClientRect();
              const separator = handle.getBoundingClientRect();
              const size = horizontal
                ? rect.width - separator.width
                : rect.height - separator.height;
              const position = horizontal ? next.clientX : next.clientY;
              if (size <= 0 || !Number.isFinite(position)) return;
              latest = Math.max(0.15, Math.min(0.85, node.ratio + (position - origin) / size));
              preview(latest);
            },
            commit: () => {
              if (latest !== node.ratio) resize(node.id, latest);
              else preview(savedRatio.current);
            },
            cancel: () => preview(savedRatio.current),
          });
        }}
        onDoubleClick={() => resize(node.id, 0.5)}
        onKeyDown={(event) => {
          const decrease = horizontal ? "ArrowLeft" : "ArrowUp";
          const increase = horizontal ? "ArrowRight" : "ArrowDown";
          if (event.key !== decrease && event.key !== increase && event.key !== "Home") return;
          event.preventDefault();
          resize(
            node.id,
            event.key === "Home" ? 0.5 : node.ratio + (event.key === decrease ? -0.05 : 0.05),
          );
        }}
      />
      <div
        className="pane-layout__child"
        style={{
          display: "flex",
          flex: "calc(1 - var(--td-split-ratio)) 1 0px",
          minWidth: 0,
          minHeight: 0,
          overflow: "hidden",
        }}
      >
        <LayoutNode node={node.second} />
      </div>
    </div>
  );
}

export function PaneLayout() {
  const layout = useWorkspace((state) => state.layout);
  const panes = useWorkspace((state) => state.panes);
  const tabs = useWorkspace((state) => state.tabs);
  return <LayoutNode node={visibleWorkspaceLayout(layout, panes, tabs)} />;
}
