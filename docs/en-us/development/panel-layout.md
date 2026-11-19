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

## Integrated workbench panels

`WorkbenchPanel` is the default container for built-in and contributed sidebar
views. It composes shared chrome, movement controls, a presentation store and the
floating geometry primitive. Business code supplies content and optional
`PanelHeader` actions once; the host relocates these actions without duplicating
titles. Only special-purpose surfaces should compose the lower-level primitives
directly. Tasks, connections, output, file preview and plugin sidebars share this
implementation rather than keeping independent floating/docked shells.

`SidebarContents` retains one React owner per visited panel; `SidebarMount` moves
its existing DOM container among sidebar, workspace and floating slots. Search,
selection, disclosure and scroll survive a same-document move. Closing a panel
hides its presentation, not its SSH sessions, tasks or plugin runtime. Workspace
close retains the hidden slot. Floating placement/pinning uses generic panel
state; legacy task geometry is migrated. Live-process checkpoints restore open
floating panels, but cold startup does not open transient windows automatically.
Removing a plugin contribution drops its presentation; stopping the runtime
retains the installed view's restart placeholder while runtime scopes dispose.

This same-document mechanism is not a cross-WebView ownership protocol: do not
promise DOM/state preservation in native windows until an explicit handoff exists.

### Experimental plugin control

`extensions.describe().panelPresentations` discovers supported presentations and
methods. `workspace.panels.list` returns `{revision,windowId,panels}` metadata:
identity, availability, presentation, visibility, pinning and geometry. No feature
contents, drafts, passwords or arbitrary stores are exposed.

- `workspace.panels.observe({revision?})` returns immediately for an unfamiliar
  revision, otherwise waits for an invalidation or up to ten seconds. Revisions
  are opaque and process-local; cancellation releases subscriptions.
- `workspace.panels.setPresentation({panelId,presentation})` moves an existing
  panel to `sidebar`, `workspace` or `floating`. A file preview must already exist,
  and plugin panels must still be contributed.
- `workspace.panels.close({panelId})` hides the panel without stopping resources.

Read/list/observe require `workspace.read`; mutations require `workspace.write`.
Normal request authorization, cancellation and final runtime-generation checks
remain in place. `workspace://panels-changed` is an advisory UI invalidation with
only `{windowId}`; RPC plugins should use `observe` and reread the snapshot, not
infer state from a delivered event. Frozen `workspace.snapshot` v1 is unchanged.

## Intersecting separators

`SplitGeometryScope` joins layouts across retained React portals without adding a
layout wrapper. The application installs one scope around its workbench; an
isolated `SplitPanels` consumer gets a local scope automatically. Connected DOM
roots are handled separately, so a floating panel cannot resize an unrelated
workspace boundary. Geometry registration uses per-instance IDs; semantic split
IDs need only be unique within each owner/batch callback, not across independent
layout roots. A changed owner or topology cancels the old gesture.

The host measures actual separator segments to find T/cross junctions. A junction
handle moves both axes; touching collinear segments move together, while unrelated
segments are excluded. Bounds are calculated in each participant's own container,
and the tightest common displacement preserves alignment at minimum sizes.
Previews use the same frame-bound pointer primitive and never rerender pane
contents or persist each movement. Escape, cancellation, focus loss and teardown
restore current controlled ratios. Arrow keys adjust one axis, Shift reduces the
step, and Home/double-click resets the participating splits.

Provide `PanelLayout.onResizeMany` for an atomic owner update. The workbench uses
`workspace.resizeSplits` to publish both axes once. Standalone controls retain
`onRatioChange`; a gesture spanning different feature owners commits once per
owner, without pretending independent persistence adapters are one database
transaction. Plugin callers can use experimental
`workspace.resizeSplits({ratios:{splitId:ratio,...}})` with `workspace.write`:
1–32 known IDs and finite 0.1–0.9 ratios are fully validated before one mutation;
existing workspace size limits still clamp values. Frozen workspace v1 is unchanged.

## Native view handoff (in development)

Native windows are not a second application bootstrap. `panel_windows` registers
host-issued document identities and generation-fenced panel leases; a move is
prepare → inert destination render → acknowledgement → singleton-main commit.
A timed-out, cancelled, reloaded or retired destination never acquires authority.
Closing a satellite returns its views before native destruction. Recovery uses
bounded in-memory checkpoints, not persisted drafts or feature-store clones.

An adapter must explicitly opt into `windowViews.transferablePanel`. The current
adapters are connection details and background tasks: main publishes explicit projections;
`ConnectionModelScope` renders the same content in a satellite without hydrating
writable application stores. `usePanelViewState` opts local React fields into a
capsule; stable DOM markers preserve scroll/caret separately. A staged tree stays
inert and is promoted without remounting. Committed state changes and DOM events
schedule bounded native checkpoints. Never acknowledge a spinner/empty shell.

The private native control grammar is closed. Model publication is coordinator-
only; reads require an exact current lease or an active staged-destination offer.
Metadata/events contain no model, credential draft or document token. Satellite
application IPC is default-deny. Closed task/disconnect action requests are
admitted using the exact source document/lease, then claimed once by main. Task
callbacks never leave the singleton registry; incarnation tickets fence replaced
sources without invalidating buttons on every progress frame. Queued work may be
cancelled or expire; claimed resource work retains its migration fence until main
finalizes it, even after the source reloads or the executor's local scope disposes.
Late claim replies must still be finalized; do not discard them through a generic
post-disposal read guard. Requests, results and tickets never enter metadata/events.
Status entry points focus the actual owner instead of creating a second main-window content owner.

This is incremental implementation, not a claim of complete multiwindow support.
`PanelWorkspace` composes the existing `PanelLayout`/`SplitPanels` and
`WorkbenchPanel`: document-local tabs, both split axes, floating and merging move
retained portal containers, not React/resource owners. Satellite geometry is
memory-only and cannot overwrite main-window preferences. Closing one satellite
panel returns only that view; native close returns all its views. Creating another
destination from a satellite requires an exact interactive adapter lease checked
before and after platform construction. Only its creating document may discard
an empty destination; abandoned initialized windows are also reaped. Reserve
native empty-window destruction under the ownership mutex so an incoming handoff
cannot race the platform destroy call. Frontend cancel/reload cannot release that
reservation; only native failure cleanup or actual destruction can.

Other built-ins/plugin views and native cross-window drag-and-drop still need
their adapters and platform acceptance. Transfer-specific reconnect/consent UI and
plugin task presentation providers still require window-aware adapters. Do not
advertise those capabilities or widen gateway permissions to hide an incomplete adapter.
The public plugin workspace v1 contract remains unchanged.
