/** Serializable split tree shared by workbench and feature layouts. Ratios are 0..1. */
export type SplitDirection = "row" | "column";
export type PanelLayoutNode =
  | { kind: "pane"; paneId: string }
  | {
      kind: "split";
      id: string;
      direction: SplitDirection;
      ratio: number;
      first: PanelLayoutNode;
      second: PanelLayoutNode;
    };
