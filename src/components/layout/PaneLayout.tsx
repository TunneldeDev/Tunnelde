// SPDX-License-Identifier: GPL-3.0-only
// Copyright (C) 2026 quyansiyuanwang (TunneldeDev)

import { useRef } from "react";
import { useTranslation } from "react-i18next";

import { PaneView } from "@/components/layout/PaneView";
import { useWorkspace, type WorkspaceLayout } from "@/store/workspace";

function LayoutNode({ node }: { node: WorkspaceLayout }) {
  const { t } = useTranslation();
  const panes = useWorkspace((state) => state.panes);
  const activePaneId = useWorkspace((state) => state.activePaneId);
  const resize = useWorkspace((state) => state.resizeSplit);
  const container = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  if (node.kind === "pane") {
    const pane = panes.find((item) => item.id === node.paneId);
    return pane ? <PaneView pane={pane} active={pane.id === activePaneId} /> : null;
  }
  const horizontal = node.direction === "row";
  return (
    <div
      ref={container}
      className="pane-layout"
      style={{
        display: "flex",
        flexDirection: node.direction,
        flex: "1 1 0",
        minWidth: 0,
        minHeight: 0,
        overflow: "hidden",
      }}
    >
      <div
        className="pane-layout__child"
        style={{
          display: "flex",
          flex: `${node.ratio} 1 0`,
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
          if (event.button !== 0) return;
          event.preventDefault();
          dragging.current = true;
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (!dragging.current) return;
          const rect = container.current?.getBoundingClientRect();
          if (!rect) return;
          resize(
            node.id,
            horizontal
              ? (event.clientX - rect.left) / rect.width
              : (event.clientY - rect.top) / rect.height,
          );
        }}
        onPointerUp={(event) => {
          dragging.current = false;
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => {
          dragging.current = false;
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
          flex: `${1 - node.ratio} 1 0`,
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
  return <LayoutNode node={layout} />;
}
