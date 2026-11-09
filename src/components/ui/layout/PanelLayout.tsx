import { memo, type ReactNode } from "react";
import type { PanelLayoutNode } from "@/lib/layout/types";
import { SplitPanels } from "./SplitPanels";

export interface PanelLayoutProps {
  layout: PanelLayoutNode;
  renderPane: (paneId: string) => ReactNode;
  onResize: (splitId: string, ratio: number) => void;
  resizeLabel: string;
  className?: string;
  childClassName?: string;
}

/** Stateless recursive layout; the caller owns pane content, docking and serialization. */
export const PanelLayout = memo(function PanelLayout({
  layout,
  renderPane,
  onResize,
  resizeLabel,
  className,
  childClassName,
}: PanelLayoutProps) {
  if (layout.kind === "pane") return renderPane(layout.paneId);
  const props = { renderPane, onResize, resizeLabel, className, childClassName };
  return (
    <SplitPanels
      key={`${layout.id}:${layout.direction}`}
      direction={layout.direction}
      ratio={layout.ratio}
      onRatioChange={(ratio) => onResize(layout.id, ratio)}
      label={resizeLabel}
      homeRatio={0.5}
      className={className}
      childClassName={childClassName}
      first={<PanelLayout layout={layout.first} {...props} />}
      second={<PanelLayout layout={layout.second} {...props} />}
    />
  );
});
