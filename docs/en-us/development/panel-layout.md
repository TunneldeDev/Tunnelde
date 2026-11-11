# Shared panel layouts

`src/lib/layout/types.ts` defines the serializable `PanelLayoutNode` tree. Leaves
identify panes; splits contain an ID, direction, ratio and two children. Ratios are
fractions from 0 to 1. The existing workspace serialization retains its shape.

`PanelLayout` in `src/components/ui/layout/` is a controlled renderer. Pass the
layout, `renderPane(paneId)`, `onResize(splitId, ratio)` and a translated accessible
separator label. It has no workspace, storage, file-browser or plugin dependency.
The caller owns validity, persistence, docking, tab actions and hidden-pane state.
Keep IDs and render callbacks stable to retain mounted content across resizing.

`SplitPanels` supplies the same splitter to tree layouts and two-panel feature
views. It supports row/column directions, flex/grid modes, configurable bounds,
separator size and keyboard/reset behavior. It previews geometry directly in the
DOM at most once per animation frame, then commits via `onRatioChange` on release.
Pointer cancellation, Escape, focus loss and unmount discard the preview. The
latest controlled ratio is restored, including keyboard changes made during a
pointer gesture. Pointer movement never persists preferences or rerenders children.

The workspace `PaneLayout` is a thin store adapter. File `FileSplitView` uses the
same primitive with its existing local preference adapter and 20–80% bounds.
Changing its storage key remounts that preference adapter, so one file view cannot
overwrite another view's ratio. Workspace limits remain 15–85%.

Application and plugin panels continue to enter the existing workspace docking
host, sharing placement, resizing, visibility and tab actions. This refactoring
does not promote experimental plugin workspace APIs into stable contracts.

Behavioral checks live in `tests/components/PanelLayout.test.tsx`,
`tests/components/PaneLayout.test.tsx`, `tests/features/FileSplitView.test.tsx` and
the workspace/sidebar docking suites. Add consumers through these shared controls
rather than implementing another pointer listener or persistence mechanism.
