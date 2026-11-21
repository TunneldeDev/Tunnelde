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
adapters are connection details, background tasks, output and trusted keys: main publishes explicit projections;
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
their adapters and platform acceptance. Other resource-specific interfaces still
require window-aware adapters. Do not
advertise those capabilities or widen gateway permissions to hide an incomplete adapter.
The public plugin workspace v1 contract remains unchanged.

### Preview resources and window handles

`createPreviewReadSource` moves read/decode/native-ticket lifetime above renderer
bodies. Displays subscribe to immutable results; subscription/unmount does not
start or close I/O. A target, provider or retry creates a new owner. Late results
after cancellation clean only their own ticket and cannot replace newer data or
close a replacement resource.

Only the coordinator document can `publishPreviewResource`. A destination uses
`openPreviewHandle` for a read-only attachment bound to its actual document and
exact lease or live staged offer. The destination never receives the raw media
ticket. Native `preview` routing validates the caller window and revalidates the
same handle after asynchronous reads. Commit promotes the staged attachment in
place. Cancellation, expiry, reload, resource replacement and ABA cannot revive
old handles. Closing a display never closes its host-owned file; late admission
replies still need cleanup. Bounded handles stay out of public metadata, plugin
APIs, the Bus and view capsules.

The docked `filePreview` adapter now uses this mechanism for explicit native
window handoff; see the acceptance scope below. The public preview v1 contract
remains unchanged.

### Background-task interface providers

Tasks retain the main window's single task registry. The selected `backgroundTasks`
provider uses native-issued display identity and target-specific permissions, not
forwarding permissions. Satellites instantiate scoped `createView` children without
replaying singleton activation. Main, staged and returned views share the state
capsule; commit waits for actual restoration/rendering. Factoryless legacy views
still reject transfer explicitly instead of silently dropping drafts.

`backgroundTasks.read` admits display; `backgroundTasks.write` admits actions.
Staged targets are read-only; stale leases, hidden replaced trees and frozen
sources cannot mutate. Submission binds the exact document, child view and lease
to the existing bounded action queue. Main resolves the task incarnation ticket
before calling its original registry callback. Tickets/callbacks never enter
public plugin APIs, capsules or metadata events. Late receipts still cancel
unclaimed work after view disposal.

Native macOS acceptance covers two main-to-satellite-to-main roundtrips, restored
drafts and satellite actions with one singleton activation. This is explicit
handoff acceptance, not physical multi-display dragging, Windows/Linux or FUSE
continuity.

### Interrupted coordinator and bounded view state

A coordinator document reload cannot prove that an already-claimed arbitrary
callback's native effects have stopped. Mark its outcome unknown, never replay
it, and keep a per-panel native quarantine independent of result TTL, source
retirement, auth unblock or panel-ID reuse. Show an alert and keep that view inert;
the user must inspect the resource and restart the application to clear this
process-local protection. Do not add an unsafe automatic retry/unlock button.

Use `PanelViewStateGroup` for repeating rows: one parent field aggregates row
states, retaining strict JSON plus the aggregate byte/node/depth limits. A long
list must not throw while rendering. Oversized captures fail before handoff,
leaving the source interactive with all drafts intact; never truncate to fit.

Document-local pointer dragging supports tab reordering, edge splits and center
docking, including the floating panel's docking grip. Retained portals follow
React ancestry rather than their physical DOM placement, so drop surfaces use
native capture listeners for the opaque document-local token. Exclude the dragged
floating surface from hit testing for that gesture and restore its original
style on release, Escape, cancellation, blur and teardown.

### Native drag bridge (in development)

The common pointer driver reports a genuine release separately from Escape,
lost capture, blur and teardown. An accepted local drop cancels its native grant.
For an unaccepted release, a host-issued, short-lived, single-use grant must be
ready already: do not wait for a delayed grant and then sample a later cursor.
The exact originating document and interactive lease are checked again at native
release. The handoff must still match that lease incarnation; never substitute a
newer owner found by panel ID. No grant or document token goes into drag readiness
metadata or plugin messages.

Native hit testing selects an existing registered window, the source (no-op), or
outside all visible application windows (create a destination). Geometry/query
errors are failures, never evidence of an outside drop. macOS cursor coordinates
use the primary monitor's backing scale while window bounds use each window's
scale; normalize both to Cocoa desktop points before comparing. Windows/Linux
retain their native physical desktop coordinates. Never trust browser screenX/Y.

Synthetic pointer tests in real WebViews validate the gateway and staged handoff,
not actual OS pointer capture, all platform input paths, mixed-monitor hardware,
SSH transport continuity or complete built-in/plugin support. Those acceptance
requirements remain before exposing the complete capability or releasing it.

### Output adapter and singleton readers

Output uses one coordinator `OutputSource`, not one log cursor per WebView.
Document-local consumers retain its reader; an owned or staged satellite adds
background demand so hiding the coordinator does not stop output. Releasing the
last consumer stops polling; a hidden local-only view waits until visible again.
Refreshes coalesce without overlapping reads, and clearing during an in-flight
read cannot resurrect cleared lines. Late replies after source disposal are ignored.

The satellite reuses `OutputPanel` with `OutputModelScope`. Its filter/channel,
severity, follow and wrap fields use the ephemeral capsule; scroll uses the shared
DOM marker. Runtime projection includes only display metadata, never full app
info, plugin runtime tokens, installation/data paths or settings. Closed output
refresh/clear/open-log/open-folder/copy requests go through the exact leased action
relay; the satellite cannot invoke raw log/filesystem/clipboard commands.

Bound output by the complete UTF-8 JSON rows, not UTF-16 message length. Output's
private read model has a separate 2 MiB envelope for bounded lines plus display
metadata; other read models and draft capsules retain their 1 MiB limit. No output
or copy text is sent through public metadata or invalidation events.

### Trusted-key adapter and document-local consent

Known-host views share a coordinator source and reuse `KnownHostsList` in either
window. Satellites receive only the trusted-key display projection, never raw
application IPC access. Search and explicitly marked scroll/focus transfer through
the normal ephemeral capsule. Refresh/forget use closed exact-lease actions.

Obtain `beginInteraction` before opening consent UI. Its opaque document/lease
scoped token blocks transfer, window creation, drag grants and close-return while
allowing the confirmed action to be submitted. Each overlapping dialog releases
only its own token. Pending acquisitions release on unmount too. These guards
retire with their document on reload/crash; they are not resource-effect fences.
An admitted action keeps its independent native fence until completion (or the
existing unknown-outcome quarantine after coordinator loss).

The originating window renders the shared controlled `ConfirmDialog`; do not
relay callbacks or open a second coordinator dialog. Show the confirmed key's
algorithm and fingerprint. Compare host, port, algorithm, fingerprint and update
identity atomically when deleting; a stale confirmation must not remove a new
trusted key. Preserve trust-lifecycle rollback and leave failures visible/retryable.
The legacy unconditional plugin operation remains compatible; built-in UI always
sends the expected key identity. Never serialize dialogs, tokens or callbacks into
view capsules, metadata events or persistent layouts.

### Window-ready transfer and connection presentation boundaries

`ConnectionPrompt` is the shared connection/host-key/credential UI, with only a
small display-only host projection and explicit `ConnectionPromptServices`.
It never bootstraps SSH, reads main credential/host stores, or navigates another
window. `ConnectDialog` is the existing main-only adapter: it retains reviewed
native targets, singleton connection acquisition and workspace navigation. Keep
that wrapper out of satellites; missing remote services must not fall back to it.
Quality testing **and cancellation** must use the same supplied owner backend.
Nested credential-forget confirmation belongs to the originating prompt, and a
failed forget must not dismiss consent or clear the saved-credential indication.

Transfer rows accept a `TransferTaskControllerScope` instead of importing raw
execution into their presentation. A native-window controller resolves closed
location kinds from the current owned task; it must not accept arbitrary paths
from the view. Local fallback preserves captured session-identity rechecks and
must never reinterpret a disconnected remote as local. Satellite use without an
explicit controller fails closed. Disclosure, speed-limit editor and unfinished
draft are opt-in grouped capsule state; pending effects are not drafts.

The native transfer adapter resolves source/task-incarnation tickets before every
command. It projects only explicit transfer display fields and inspection
availability, not session handles or writable stores. Closed location kinds are
resolved from the current task in the coordinator; a missing remote never becomes
a local path. Inspect explicitly reveals the main file workspace through the
registered document's native show gateway, without expanding generic window IPC.

Acquire the exact native consent token **before** mounting a reconnect prompt.
Native verifies that token at action admission and again at claim. Sequential
missing-endpoint prompts retain one guard; each effect has its own native fence,
which outlives the dialog. Cancel must not resume a transfer. An expired task or
prompt must remain dismissible and release its UI guard even if remote close
fails. Pause/cancel/resume must await backend admission rather than acknowledge a
fire-and-forget store update.

Reviewed connection handles are private and bound to lease generation, task
incarnation and consent token. Bound their count and idle lifetime, retire them
on owner/source loss, and cancel only their own namespaced diagnostic tests.
Whitelist route hosts for credential/key effects; construct background connection
requests in the coordinator instead of accepting arbitrary targets. Bulk saved
credential status comes from one private preparation, not an unbounded fan-out of
relay jobs. Never return key-installation paths, review tokens or credentials in
read models, capsules, public metadata or events. Native admission cannot be
undone by component cleanup; keep its independent fence until effect completion.

### Independent plugin view transports

Keep frontend activation/readiness in the coordinator; view transports are its
bounded revocable descendants, not competing activations. Import immutable
approved assets by reference. A view must not acknowledge or fail activation;
closing it cannot retire sibling views or dependency consumers. Replacing or
closing activation retires all descendants and their pending calls. Optional
state factories do not themselves grant native window access or provider handle
parity. In particular, do not substitute an async factory shell for a provider's
synchronous Workspace/Screen contract. Retain legacy renderers until explicit
per-document admission, state warnings and domain gateways are available.

Protocol CORS uses the trusted configured development URL's origin, never an
Origin header echoed from a request or a hardcoded port. Packaged application
origins stay unchanged. Keep isolated native QA identifiers/data separate from
the installed application and test actual module imports, not only mock loaders.

### Public native-window metadata and lifecycle APIs

`extensions.describe().nativeWindows` advertises the permission-checked
experimental RPCs `workspace.windows.list/observe/create/close` and
`workspace.panels.ownership`. Read methods require `workspace.read`; lifecycle
methods require `workspace.write`. They do not change frozen
`workspace.snapshot` v1, reveal private document tokens/capsules/models, or grant
satellites raw application IPC. Ownership generations and `canMove` are advisory;
all actual mutations still check native state.

List and ownership return the same revisioned native snapshot, including window
roles/readiness/close state, panel IDs and current owner generations. Observe is a
cancellable ten-second long-poll subscribed before inspection; feature progress
alone does not change its revision. `workspace://windows-changed` contains only an
opaque revision invalidation hint. RPC clients can use observe instead of native
JS events; revisions have no durable replay guarantee.

Create returns a hidden host-built satellite placeholder, using existing native
monitor-aware placement and a global limit of 16 windows. It accepts no URL,
script, caller label or arbitrary native command. Empty placeholders expire after
20 seconds. Cancelled creation waits retain native construction to settlement and
clean late empty results, including sent-but-unconsumed replies. Plugin revocation
cleans only its older-generation empty placeholders. Never destroy a populated
window or interrupt an active handoff because its creating plugin retired.

Close only requests the usual satellite capture/return protocol; it cannot close
the coordinator, force-unmount a view, discard drafts, bypass credential consent
or stop SSH/tasks. The reply `{windowId, requested: true}` means accepted, not
closed; observe native metadata for completion or retry after a guarded failure.
Native platform close/capture failure must leave ownership recoverable.
Platform construction/setup errors use the same atomic empty-window reservation
as cancellation and timeout cleanup. A newly ready destination can already hold
an unrelated user handoff before its creator finishes; never force-destroy it
merely because that creator reloads or loses authorization.

### Public moves execute in the source document

`workspace.panels.moveToWindow` requires `workspace.write`, a supported panel and
an existing ready native destination. Its optional `expectedOwner` window and
generation reject stale automation rather than retarget a newer incarnation.
The native request records both document identities, reserves that panel, then
lets only the exact source claim a closed, opaque capture job. Never capture a
satellite's state from coordinator stores or relay arbitrary UI commands.

Only native prepare/ready/commit transfers authority; the RPC completes with the
new owner generation after commit, not after queueing or source capture. Recheck
plugin policy at claim, prepare and commit. The final bounded metadata mutation
holds policy authorization through commit, linearized with revocation. Lock order
is native ownership -> policy -> invocation; retirement releases policy before
native cleanup. The invocation fence synchronously rechecks transport cancellation
and deadline while holding its entry lock through the bounded commit. A cancel
that already returned cannot be bypassed just because the async caller has not
been polled again. Never do resource work, await, or acquire request registries
inside this fence.
Cancellation/revocation before commit removes the queued reservation or staged
offer and keeps the source authoritative. Cancellation after commit does not undo
an accepted move. Reload, crash, timeout, unavailable view and panel removal must
retire only the matching request; effects/resources never become request assets.

Bound pending moves to 32 total and eight per plugin, with a 25-second request
lifetime in addition to the normal handoff deadline. The source executor releases
late claims and in-flight reservations on disposal. A coordinator that finds an
acknowledged offer already retired after a failed commit should reconcile the
current native snapshot, not report a false failure for expected cancellation.
The caller owns request error presentation; satellites do not show unsolicited
error toasts for a plugin's cancelled operation. Transferability remains explicit
adapter opt-in; this API does not grant unsupported providers native parity.

### Source-document presentation adapters

Install one private presentation adapter per document. The coordinator adapter
must reject mutations for panels owned by another window; the satellite adapter
uses only its local workspace and floating slots, never main feature stores or
resource bootstrap. Expose closed layout metadata and synchronous set/hide/reveal
operations to the native source router, not arbitrary store access.
Satellite supported presentations are workspace/floating; never silently map an
unsupported sidebar request to another presentation.

A hidden local view retains its original slot, split geometry and portal owner.
Render a pruned visible layout, not a destructive rewrite of the source layout;
revealing must restore the same DOM/draft and group. Removing native membership
still releases the slot and its observers. The adapter is document-local; public
panel APIs route through native ownership, not through a coordinator proxy.

Native focus must reveal the requested panel, not merely raise its window with
an unrelated active tab. Notify only the native-sampled owner lease after focus;
recheck document/generation, and let the source reveal only its exact current,
non-staged lease. Focus never starts resources, restores plugin activation, or
grants a satellite additional application IPC authority.

### Public panel metadata and admitted presentation effects

`workspace.panels.list/observe/setPresentation/close` are native workbench RPCs.
Read methods require `workspace.read`, presentation changes `workspace.write`.
List/observe project closed layout metadata published by each exact owner
lease/document: window, presentation, visibility, pinning, bounded geometry,
availability and supported presentations. No view content, credentials, draft
capsules, plugin tokens or feature models are included. Frozen workspace v1 is
unchanged. A missing source publication yields `panel.window.viewNotReady`
(list waits up to two seconds, observe up to ten), not fabricated main metadata.
An unavailable file-preview catalogue row remains main-only and never visible.

Layout revisions are independent of resource progress. Subscribe before snapshot
inspection; `workspace://panels-changed` emits only an opaque revision hint.
Stage the destination's actual metadata before acknowledgement and copy it with
the new owner on commit, so a completed move cannot report the old source slot.
Reload/owner changes invalidate old metadata until the exact source republishes.

Set/close reserve a closed source operation with a plugin lease and synchronous
invocation fence. Only the exact source claims it, once. Native Begin rechecks
ownership, interactions, policy and cancellation in ownership -> policy ->
invocation lock order; it is the accepted-effect admission point. Before Begin,
cancellation frees the reservation and cannot mutate UI. After Begin, the
accepted synchronous effect is not rolled back by caller cancellation, timeout
or permission revocation. Its native fence must remain until source completion
or exact-document loss; never expire it while a delayed Begin reply could still
change a view which another window has acquired. Cancelling window close does
not retire a document or free an admitted effect. Panel ID reuse is also blocked
until the effect settles.

After Begin returns, the executor rechecks its lifetime/adapter and synchronously
changes only its own layout, without an intervening await. It completes with
actual metadata (Set must match the requested visible presentation; Close must
be hidden), or releases the job via a cleanup-only exact-source failure call.
Late claims, disposal and adapter replacement never mutate retired views.
Reserve that panel’s publication lane until completion so an older refresh
cannot overwrite the accepted result; other panels must continue publishing.
Limit pending operations to 32 globally/eight per plugin, with a 15-second queued
TTL and a 20-second RPC wait. These are presentation-only operations: hide keeps
the renderer, slot and drafts, and never stops SSH or other running resources.
Unsupported source presentations fail explicitly rather than retarget main.

### Asynchronous ephemeral view capture

Panel handoff and checkpoints await `captureAsync`; synchronous capture remains
available for synchronous built-in fields but explicitly refuses async-only
fields. A panel shares one capture at a time with a 15-second deadline. Cancelling
one waiter does not release an uncooperative renderer's reservation. All selected
callbacks must settle (including after a sibling fails) before new work is
admitted. Strict JSON, field and aggregate size limits apply without truncation.
Content changes invalidate an in-flight capsule; the window adapter retries only
within its original deadline, then rechecks the exact controller, lease and DOM
root before publishing. No capsule is persisted or added to public metadata.

Factory renderers bind `{version, pluginId, viewId, state}` to their panel scope.
Restore completes before mounting the actual renderer, and stage acknowledgement
waits for its committed readiness, including newly registered child fields.
Loading shells and error fallbacks never acknowledge a destination. Focus/caret
restoration waits for both readiness and ownership commit. Capture source DOM
state before `inert` can blur it, and restore its caret on rollback only after
both local and native freezes are gone. A renderer failure is
contained to its panel; a failed stage rolls back to the original source.
Stateless factories explicitly reject capture rather than inventing empty state.

Satellite close captures all owned panels before native `beginClose`, then checks
its atomically frozen membership matches every captured lease. Failure cancels
only a begun native close and unfreezes the exact original leases; old cleanup
cannot unfreeze a replacement incarnation. Disposing a document cancels pending
captures and prevents late preparation.

This is the asynchronous state/readiness foundation, **not** a plugin native-view
gateway. Transferable built-ins remain explicitly opt-in; satellite plugin
activation/raw RPC, legacy-state warning UX and provider parity are not implied.

### Origin-scoped plugin consent (internal gateway)

A native view's `ui.confirm` / `ui.showMessage` is queued for its exact owning
window and document, never forwarded to the hidden coordinator. Invalidation
contains no prompt text or capability. The closed list/reply gateway derives
native window identity, validates document and request ownership, then rechecks
panel lease, view token, plugin generation/permissions and invocation cancellation
inside the final delivery gate. Staged or frozen views cannot request consent.
The lock order is ownership -> frontend module -> plugin policy -> invocation;
never reenter security or native ownership inside that synchronous gate.

Consent holds a panel interaction until settlement, blocking handoff. There is
at most one confirmation per native window, eight queued UI requests per plugin
and 64 overall. Confirmation times out to false after 55 seconds; messages time
out after 15 seconds. Transport cancellation and permission/document revocation
withdraw old consent without permitting a late approval. The shared confirmation
host runs in both document types without importing the main resource bootstrap.
Existing user dialogs are never replaced; messages are shown once and acknowledged.
Advisory refresh plus bounded polling withdraws expired prompts if an event was
missed. Disposal rejects active consent and ignores late UI replies.

`mounts.runtime.requestForceUnmount` is a separately audited, committed-only
native call. Its host-private `__mounts.forceUnmount` prompt always uses danger
styling and defaults focus to Cancel; public `ui.confirm` parameters cannot select
this route. The pending consent keeps `mounts.write`, the exact origin and the
original invocation attached through reply. Consent binds rule/group/revision/
runtime/session identity; acceptance rechecks it under the group gate and again
at effect admission after filesystem probes. Never reuse consent for a replacement.

The retained unmount policy commits `desired:false` atomically with cancellation
admission under metadata-only origin, policy, invocation and runtime gates (in
that order). Notifications happen after those gates are released. Before admission,
cancellation, revocation or identity changes leave the original intent intact.
After admission, the worker owns the group gate through dismount, process reaping
and host-state settlement, even if result delivery expires or permissions change.
Success clears the runtime/session; failure retains the exact cleanup reservation
with `cleanupRequired` and `desired:false`, so recovery cannot remount it. Final
bookkeeping is completion of an admitted effect, not another plugin-authorized
write. The frontend consent host registers its exact callback before publishing
a dialog, tolerates synchronous accept/dismiss/replacement/disposal and never
closes a later unrelated dialog. Unit subprocess fixtures are not physical FUSE
acceptance; keep that distinction in verification reports.

`mounts.legacy.list/convert/dismiss` likewise require a committed native view.
Capture the original origin and invocation before any wait or spawned worker.
When SQLite's mutex is busy, leave every admission gate before bounded worker
retries; never block an async executor or wait for the DB mutex under policy locks.
Conversion retains the group and mount-registry guards through same-host/group
revision/create-only persistence, ownership transfer and runtime publication without
an async gap after commit, even after delivery cancellation. Failure transfers no
ownership. The legacy user's SSH session is borrowed, never registered as a
host-owned dedicated connection, disconnected by group connection release, or
mistaken for a group connection by recovery.

`mounts.runtime.open/reveal` recheck the original origin, invocation, write grant
and exact rule revision/group/runtime/session at OS-launch admission. Registry and
group reservations span probes, canonical containment and launch, preventing an
unmount/replacement from overtaking a stale snapshot. Nested filesystem timeouts
end delivery only: actual workers retain those reservations and the inherited
native effect until the call returns. Unmount presence/identity probes retain the
same registry/group reservations after a nested probe timeout, before any
dismount is admitted; a retry cannot overtake the still-running old probe.
macOS device queries, canonical resolution,
compatibility opens and bounded Linux mount-table reads share retained workers.
Launch/reveal occurs outside metadata admission gates; accepted work settles
without reauthorization after permission loss. Simulated OS openers and ordinary
subprocesses are not physical FUSE or system-file-manager acceptance.

`mounts.dependencies.documentation` opens only the fixed host-selected platform
link; it does not scan local FUSE paths or run SSHFS merely to open instructions.
Both persistent and legacy entry points capture the original origin/request and
recheck `mounts.read` at browser-launch admission. The bounded actual opener
retains the native effect through completion, including cancelled delivery, and
runs outside admission locks. Staged renderers cannot launch it.

This internal transport and its tests do not declare the production plugin panel
adapter or resource-RPC/native-window parity complete. Keep discovery conservative
until real adapters, actual effect lifetimes and native acceptance are finished.
Panel IDs accept the complete combined plugin/view identity (7 + 128 + 1 + 128
ASCII bytes); do not truncate distinct IDs to fit an older 256-byte limit.

## Ordinary pages and empty groups

All built-in workspace pages can move to a same-document floating window through
its tab/group menu. `PanelFrame` is the common surface, geometry and Escape layer
for pages and `WorkbenchPanel`; the two are adapters, not separate window systems.
`WorkspaceContents` still owns each page once. `TabContent` reparents the retained
container, preserving editor drafts, terminal instances and component state.
Floating groups keep a dock target and remember their return group; Escape or
Move to workspace redocks, while the tab close action actually closes the page.
Dragging its tab into another group uses the ordinary workspace drop adapter.
Floating geometry is transient and excluded from frozen workspace v1; cold-start
restoration places saved pages in ordinary groups. This is not native-window
handoff, which requires the separate ownership protocol above.

Contributed plugin views may declare `allowFloating: false` in their manifest view
entry. Omission permits floating. The host enforces the opt-out at mutation time
and omits that presentation from discovery and menus. Built-in pages do not have
an allowlist or opt-out. All floating adapters share one stacking clock.

Use `--td-workbench-header-h` for sidebar, panel and tab chrome. An empty group has
no tab toolbar, lock or overflow actions, but its body remains a drop target.
Compact native windows retain only the necessary window-controls/drag safety area.
Workspace panel chrome must not duplicate tab placement/close controls; feature
commands remain in one business toolbar. Output keeps channel, search, severity,
follow, clear and overflow together below the tab strip and registers no tab actions.

## Closing connection consumers

`disconnectOnPanelClose` defaults to true, including older settings files. Explicit
closing releases the exact session only after its last terminal, SFTP source,
editor or monitor consumer disappears. Track both sources of a dual-file pane.
Rule-owned forwarding/mount connections are not released by ordinary page close.
Moving, redocking, hiding or unmounting a view must never disconnect. Opting out
keeps sessions in the background. This additive setting is available through
`settings.get/update` and settings profiles; frozen public preferences v1 is not
silently extended.

The connection manager uses shared `SearchToolbar`/`SearchField` parsing for text,
`@type`, `@status` and `@host` filters. Selection is limited to live visible results;
changing the query clears it. Batch confirmation binds a fixed set of IDs and
cleanup runs with bounded concurrency, retaining failures for retry. History is
searchable but never selectable for disconnection.

### Forwarding view-state adapter

Forwarding host selection, rule editor identity, partial input strings and group
editor/name drafts use the common ephemeral panel capsule. External navigation
is consumed into that selection so another document does not need to hydrate the
main navigation store. Drafts bind host/rule/revision; empty port inputs stay
strings until explicit save. New group drafts carry a host identity even before
an ID exists. Cancelling closes and unregisters the draft; capture does not save,
connect, restart or persist preferences.

Provider continuation authority is document-local and must never be serialized or
silently replaced with unrestricted built-in authority. Capturing a provider-owned
editor, pending connection/confirmation, or in-flight rule/group mutation is
rejected. This capture-time guard is not a native effect fence or proof of a
complete forwarding native-window adapter: native resource admission, origin UI,
shared data/action transports and provider handles still require their own gates.

### Forwarding shared read sources

Host details and the global forwarding panel retain the same singleton rule and
explicit group sources. The private `forwarding_groups_list` command accepts an
optional host ID; omitting it reads all groups, including groups with no rules.
Consumers filter by host identity, never infer group existence from rule rows.
The first subscriber starts observation and a read; the last subscriber retires
observation, clears the snapshot and fences abandoned responses. Invalidations
coalesce to one trailing read. Group mutations refresh both sources even after
partial failure, and manual refresh retries both. This document-local source is
a prerequisite, not an implementation of cross-window data/action transport.

### Host-owned mount maintenance and legacy documentation

Plugin queries no longer run global process/bridge cleanup as a hidden preflight.
The existing host recovery loop performs nonblocking registry maintenance, including
one-off mounts with no persistent group. An occupied registry reservation is
skipped until a later pass; healthy workers, ownership and existing cleanup errors
are preserved. Exited workers remain recorded until filesystem absence is proved;
a process exit is not permission to remove an active mount record. Maintenance
publishes a change only when it records a new cleanup status.

The existing `mounts.documentation` RPC uses the same exact-origin/read-grant/
invocation-fenced browser launcher as `mounts.dependencies.documentation`, without
legacy registry cleanup or dependency probing. Both are committed-only native
calls. This does not admit other legacy mount aliases or prove physical FUSE or
OS browser acceptance.

### Forwarding model and service boundaries

The private forwarding read model explicitly projects display-only host metadata,
rule configuration/revision/runtime markers, groups (including empty groups),
session IDs/host IDs/purpose and rendered error messages. It does not clone host
key paths, notes, credentials, proxy settings, plugin grants or arbitrary error
objects. The coordinator retains the same rule/group readers as local consumers
only while a destination/transfer needs them; subscribing to the publisher alone
starts no I/O. Original shared readers fence abandoned responses on release.
Read-model publication remains subject to the native size and ownership gates.

Rule/group/session hooks can consume an explicit read scope without starting
local readers or hydrating writable stores. Existing controller, row and group
components use a complete `ForwardingActions` scope for mutations and clipboard;
only the main-document implementation owns IPC and committed source updates.
A rejected scoped service never retries through the built-in implementation.
Provider continuations remain document-local authority and are reauthorized after
scope acquisition. Capture action identity and editable fields before that await;
never serialize provider authority or transient connection credentials as drafts.
The main implementation refuses satellite effects. Disconnect observes native
failures, retains failed sessions and continues the remaining captured batch.

These are reusable data/service adapters, not complete native forwarding support.
Host dialogs, connection review/confirmation origin guards, provider-native
handles, closed native action transport and actual resource-effect fences still
need integration and acceptance before adding forwarding to native discovery.
No satellite renderer or forwarding transfer admission is enabled by this work.

Builtin forwarding stop now binds the displayed rule revision and exact runtime
incarnation, including an explicit inactive snapshot for pending starts/retries.
The automation admission lock covers registry/DB CAS and pausing; rejection does
not cancel a newer attempt or change recovery intent. Cleanup is spawned before
returning its delivery handle and retains the listener's group-connection owner
until shutdown. Historical callers omitting both tokens retain their existing
behavior; instance-only requests reject, never fall back to a blind stop. These
are domain correctness guarantees, not native-window action/origin admission.

### Builtin forwarding native mutation ingress

The private `panel_window_forwarding` grammar currently accepts rule saves,
exact-snapshot stops/removals, group saves and empty-group removal. It accepts neither a
provider origin, SSH IDs, arbitrary command names nor caller window labels.
Reviewed start credentials use a separate closed, bounded, request-local payload;
never publish them in read models, layout capsules, logs or events. Save binds revision/group/automation explicitly; non-loopback
exposure requires a current interaction from that same document and panel lease.

Admission checks the native IPC label, document, exact lease and live panel;
a worker rechecks them while holding ownership over the synchronous domain
transaction (ownership → automation for stop/removal → forwarding registry → database).
Only one direct operation per panel is admitted; replies await the guard's actual
settlement, including descendant cleanup of the last pooled transport. The actual-effect guard lives
inside the native worker, not the JS response; stop/removal retains it through already
spawned listener/connection cleanup. Reload or lost consent before the final gate
rejects; cancellation after commit is not rollback. Removal cannot erase a direct
native effect's sole fence. Historical relay jobs keep their separate settlement
and unknown-outcome quarantine across panel removal.

Removal requires the original live deletion-confirmation interaction, rule
revision and exact runtime (or explicit absence). Runtime validation precedes the
metadata transaction under the same registry lock; a stale runtime cannot delete
metadata before rejecting. Rule, revision, automation settings and group membership
are deleted atomically, leaving the group itself intact. Rejection must not pause
newer recovery or cancel newer starts. A later confirmation in the same document
cannot authorize the original request after its consent disappears.

This ingress and its typed document client do not constitute a complete native
forwarding adapter: connection/prompt and provider handles, deletion-confirmation UI,
clipboard/host dialogs and the satellite renderer still require integration and
acceptance. Forwarding transfer discovery remains disabled. Never add per-method
raw-command fallbacks to make an incomplete remote service look complete.

### Reviewed builtin forwarding starts (private gateway)

`prepareStart` returns only prompt-safe host/jump metadata and a native route
review, never a full host/key path/proxy/credential record. `start` binds that
review, rule revision and the original live owning-panel interaction. It forces
background forwarding purpose and host-owned group pooling; arbitrary SSH input,
foreign jump credentials, caller window labels and provider authority are not
accepted. This transport is not yet a complete connection-prompt adapter:
actual prompt/provider/renderer integration remains mandatory before forwarding transfer discovery is admitted.

The private `probe`/`trust` operations bind the same rule revision, route review
and original interaction. Only bounded credentials for actual reviewed jump
hosts are accepted. Trust re-probes the exact route, compares the displayed
fingerprint and expected hop, and observes proxy/keychain state outside locks.
Its final ownership-held write checks the rule revision/host and native route
under the same DB guard before approving only the observed endpoint and returning
an advanced review. Failed or retired operations cannot approve a replacement
rule, host, route or dialog. Transport cleanup retains the effect through actual
settlement even when IPC delivery is lost; these methods do not enable discovery.

A private `WorkLifetime` may carry a synchronous native publication authority.
Bounded descendants inherit the effect and check before worker admission and
network/authentication steps. Route/keychain observation stays outside ownership
locks; final unpublished-session insertion and listener admission recheck the
exact original window/document/lease/interaction under short ownership guards.
An opaque observed-start proof remains paired with its pending listener, so slow
OS inspection never happens while ownership/automation/registry locks are held.

Pending routes/listeners and unreceived deliveries retain their effect across
caller retirement and descendant cleanup. Cleanup scopes keep the fence without
requiring fresh consent to dispose the original resources. Remote-forward
cancellation retains it through the SSH peer acknowledgement, not just enqueue.
Admitted listeners release the temporary start effect while keeping their group
transport, so a running rule does not permanently block panel movement.

### Reviewed builtin forwarding credentials (private gateway)

`credentialStatus`, `saveCredential` and `forgetCredential` bind the original
owning-panel interaction, exact rule/revision/host and route review. Status
returns a boolean only; writes accept a bounded request-local password, never a
physical keyring identifier, caller-selected service or provider origin. Only the
reviewed target or its actual jump hosts may be addressed. Credential binding
admission and publication repeat native origin, rule and route checks together
under short authority → DB guards. The captured credential request retains its
original authority even outside the submitting task scope; platform read/write
callbacks run with neither guard held. Revocation or a rule edit during OS access
cannot publish the staged item or erase a replacement binding.

Exact-item retirement requires no replacement consent. The existing finite
cleanup runner retains originating effect fences through admitted OS work,
including late producers and canceled coordinators; a replacement runner's empty
scan cannot settle an older worker. Durable cleanup failures keep their original
records rather than retrying a save or following a changed logical target. These
services are prerequisites, not complete prompt/provider/renderer integration or
permission to advertise forwarding native-window support.

### Reviewed builtin forwarding connection tests (private gateway)

`test` binds the original window/document/lease/interaction, exact rule revision
and reviewed route, accepting only bounded credentials for actual jump hosts.
Its lowercase UUIDv4 `testId` is private correlation, never the global SSH test
identifier: native code generates a separate internal diagnostic ID and uses the
existing three-sample, 25-second measurement budget. Results recheck rule/route
and original authority before committing; a canceled or retired test cannot
publish a late result or admit another network/credential worker.

`cancelTest` signals only the exact originating scope. It remains usable during
that panel's occupied effect fence and after the original consent is retired,
because disposing that same admitted work requires no new consent. It grants no
permission to cancel another window, document, lease, interaction or global SSH
test. Early cancellation leaves a sticky tombstone; at most 64 records are kept,
and live-dialog history is never evicted to admit a replay. Retiring the original
scope cancels active work and reclaims settled records. Result commit wins once;
a later cancel is idempotent, not rollback.

A cancellation acknowledgement is not IO settlement. The original native effect
and panel-removal/transfer fence remain until admitted workers and actual
transport cleanup finish, including work outliving the test future. The owning
test's IPC reply awaits that settlement. No global `ssh_cancel_test` fallback,
provider authority serialization or forwarding discovery admission is added.

### Reviewed builtin forwarding key installation (private gateway)

`installKey` requires the exact original panel interaction, displayed rule
revision/host and route review. It accepts bounded request-local password/jump
credentials, never caller-selected key paths, keys, session IDs or provider
origins. Descendant authentication workers also retain the original native
origin and rule predicate; a later dialog cannot replace retired consent.

Shared key setup observes OS/proxy state outside authority/DB guards, then checks
origin, route and the additional rule CAS together at local-publication admission,
before remote directory/create/append/write admission and in the same DB guard
that switches the original host to key authentication. The staged local private
key is checked again after generation and before non-overwriting publication;
a denied publication removes its staging file. Remote WRITE is checked again
after APPEND open and its exact handle is closed on failure. WRITE and CLOSE
acknowledgements must arrive before local authentication settings may change.
No ownership/DB lock spans key generation, filesystem or network IO.

External effects already admitted are not rolled back: a local managed key or
remote directory/file/key may remain after a later error/revocation. A rejected
final CAS must not switch a replacement host/rule to key authentication. Private
SSH setup and actual transport cleanup retain the native effect until settlement,
not just RPC delivery. The native reply is `null`, with no key path/bytes; success
closes the prompt and future actions prepare a fresh review because authentication
changed. This prerequisite still does not enable forwarding native discovery or
replace the remaining prompt/provider/renderer integration and full acceptance.

### Origin-window builtin forwarding prompts

`createForwardingWindowPrompt` supplies every `ConnectionPromptServices` method
through the closed native gateway. It captures exact rule/lease identity and
acquires an original interaction before `WindowForwardingConnectDialog` mounts
the shared interactive prompt. Only display host/jump metadata reaches React;
route reviews, typed credentials and correlation records remain document-local,
never layout capsules, model broadcasts, plugin messages or writable host stores.
Provider hosts/routes reject here until their separate native handles exist.

React starts probe and credential reads concurrently. The adapter serializes
actual native requests (including independent jump status reads), recovering its
queue after errors without retrying effects. Successful trust advances the review
inside that queue before the next request. Editable input is captured at service
submission, not when a queued job eventually starts. The native host owns SSH
purpose/grouping; arbitrary SSH parameters are not relayed. `forward.changed`
clears typed credentials and disables reconnect until the prompt is reopened.

Cancellation bypasses the queue and stays tied to the original correlation and
interaction; it does not unblock queued work before native test settlement.
Live-dialog history is bounded64 with no replay/early-cancel eviction. Closing,
failed preparation, replacement identity, unmount and lifecycle replay retire
that exact original interaction, including late acquisitions. Local dismissal
does not wait for IPC; late results/queued writes cannot revive it. Actual native
workers retain their independent effect fences through settlement. Equivalent
read-model refreshes must not reacquire consent/restart probes. Nested credential
forget remains the shared document-local controlled confirmation.

This complete builtin prompt service/UI prerequisite does not itself mount the
full forwarding renderer or provide provider/disconnect/host-dialog adapters.
Forwarding transfer discovery and `nativeWindows` remain disabled until those
and the full ordinary-page/native acceptance requirements are complete.

### Original forwarding confirmations

`WindowForwardingConfirmationScope` composes the shared controlled `ConfirmDialog`
with an original `createPanelWindowInteraction`; the builtin connection prompt
uses that same lifecycle primitive. The forwarding controller supplies cloned
rule/edit inputs and fixed disconnect session IDs to a document-local confirmation
service. The exact original interaction is passed only to the corresponding
save/remove/disconnect action, not provider authority or checkpoint state.
Native scopes acquire before displaying approval, retire late acquisitions,
refuse overlapping replacement, and invalidate retained callbacks/visible UI on
client or lease replacement. Equivalent read-model updates and lifecycle replay
must not reacquire or silently replace visible consent. Pending/visible approval
blocks capture and is never restored as an already-approved draft. A satellite
without an explicit confirmation service fails closed rather than borrowing the
main dialog store. Main-document behavior keeps the existing confirmation host.
This UI boundary does not itself provide native disconnect/provider/host services
or the full forwarding renderer, and does not enable native transfer discovery.

### Exact forwarding-session disconnect

The private native forwarding gateway accepts `disconnect` with a fixed builtin
host/session and the original confirmation interaction. It does not proxy raw SSH
commands or accept serialized provider authority. Under the current owner guard,
a short automation → registry → database → SSH-manager transaction verifies a
published, non-terminal forwarding session for that host before detaching any
listener or invalidating a pending start. A denied selection cannot pause newer
recovery. Successful manual disconnect pauses the selected session's rules and
pending siblings in the same host/group, not other groups or ungrouped rules.

Exact listener/transport handles retire outside those locks. Remote cancellation
acknowledgement, mount cleanup and transport closure retain the initiating effect
independently of IPC delivery or withdrawn consent; cleanup is not a new connect
permission. Failure of one listener does not skip remaining transport retirement.
Leftover mounts report incomplete cleanup rather than false success; this is not
real FUSE continuity acceptance. Main-window panel removal remains fenced until
actual admitted work settles. The full forwarding renderer/provider/host services
and cross-platform physical drag acceptance are still prerequisites for enabling
native transfer discovery.

The same private forwarding gateway supports bounded `copyAddress` text writes
(up to 512 UTF-8 bytes; no control characters). It has no clipboard read, raw
command or provider-origin field. Actual worker admission rechecks the exact
window/document/lease before OS access, outside ownership locks. An admitted OS
write retains the native effect through settlement even if IPC delivery is lost;
it cannot be rolled back by later document retirement. This primitive alone does
not admit a complete forwarding view or provider adapter.

### Selected forwarding-provider attachments

The private native plugin-view gateway can describe the selected forwarding
provider and attach a scoped child to an exact owned forwarding lease or staged
offer. Selection comes from host settings, not caller-supplied activation tokens.
The descriptor contains module identity and a selection revision, never the
singleton activation credential. Opening reuses that running activation; it does
not start a plugin or run `activate` again. `allowFloating: false` is respected.

The child is bound to the native caller document, panel, builtin host, selected
view/runtime and selection epoch. Switching away and back cannot revive an old
descriptor or child. Module loading, call admission, origin checks and UI replies
recheck the binding; host removal, permission loss, runtime retirement and native
document/offer invalidation revoke access. Exact handoff promotes the staged child
using the existing view lifecycle, while admitted effects retain their independent
settlement fence. Closing a child never closes the singleton or a replacement child.

Attachment alone does not confer mutation authority or provide a complete
provider renderer. A native child cannot use the raw main-document
`forwarding_provider_open` bridge. Provider actions/prompt integration still need
their own exact-origin native services before the forwarding adapter is admitted
for discovery; an attachment does not register an ordinary sidebar adapter or
enable native-window discovery.

### Native forwarding-provider mutation ingress

The private native plugin-view gateway also accepts a closed `forwarding`
request with the original native child token, committed lease and typed mutation.
It never accepts caller-selected plugin identity, permissions, provider bearer
origin or arbitrary invoke. Staged/frozen children cannot mutate. Admission and
actual short domain effects recheck the exact original child, selected module,
selection epoch, read/write policy, builtin host and captured rule/group revision.
Write operations require `forwards.write`; reads retain the existing provider
read policy. Callbacks under these locks must not reenter frontend/security or
perform OS/network I/O.

Provider-created listeners retain the originating plugin generation for runtime
cleanup. A delayed network setup cannot publish after selection or permission
loss. Already-admitted stop/disconnect cleanup retires its original handles even
if selection is revoked; actual descendants keep the panel fence until settlement.
Diagnostic cancellation is bound to the original child, not a replacement or the
builtin route, and policy loss cancels pending provider diagnostics.

This is a service ingress, not the complete `ForwardingActions`, provider prompt
or production satellite renderer. It does not enable native-window discovery or
relax the raw main-document frontend lease bridge.

### Original-window provider connection prompts

The shared `WindowForwardingConnectDialog` can use an explicit native provider
child. All prompt phases use that same child transport: preparation, trust,
diagnostics/cancellation, credentials, key installation and managed rule start.
The panel client supplies only the original interaction lifecycle, never a builtin
mutation fallback. Equivalent read-model refreshes preserve consent; replacing the
child, provider client, rule revision or native owner retires the old scope. Late
preparation/completion cannot be delivered to replacement callbacks. Secrets stay
in direct prompt requests and are not checkpointed or projected into read models.
Following batch targets are captured in order with original rule revisions and
one builtin host. Each following rule is prepared independently, and may start
only against the route already reviewed by the prompt. Per-rule listener failures
are reported without skipping later rules; invalid host credentials/trust stop the
batch to avoid repeated authentication failures across independent SSH groups.
Results contain rule/session metadata and errors, never credentials. A successful
start cannot be replayed by retrying a failed completion callback; opening a fresh
prompt is required. Partial failures reach the host callback or an error toast.
This still does not supply a complete satellite renderer or forwarding adapter.

### Shared native forwarding-provider surface

`WindowForwardingSurface` uses the shared persistent rows/editor composition,
but discovers its provider through the native selection descriptor, not main
settings/security stores or `frontendRuntime`. The optional write capability is
an informational hint from current grants, not declared permissions or mutation
authority. Every effect still uses the original native child and reauthorizes.
Factory creation never starts another singleton or falls back to a builtin
mutation when the selected provider fails.

Selection, security, runtime and ownership notifications trigger coalesced
metadata reads; their payloads are never passed to the plugin. An unchanged
descriptor preserves the component, attachment and draft. Selection revision
changes (including ABA), write-capability changes and deselection retire the old
source. A transient discovery error retains its draft and offers explicit retry.
Staged views can read; promotion replaces action ownership without remounting the
child, and captured old-owner callbacks cannot mutate. Late imports, observers
and attachments are released on retirement. This shared surface is not yet
`SatelliteApp` admission or complete native-window acceptance; discovery remains
disabled until the complete adapter set is accepted.

`WindowForwardingPanel` is the view-only production composition used by the
satellite renderer. It consumes the coordinator's explicit forwarding model and
does not subscribe to main host, SSH, navigation or dialog stores. Its stable
display owner survives staged promotion, while committed lease effects acquire
fresh action services; transfers, interruptions and replaced records freeze old
callbacks. Confirmation ownership changes no longer key/remount the content tree.
Provider drafts and native editor fields participate in the existing ephemeral
panel capture contract; credentials and original action tokens do not.

Manual refresh uses a closed, no-argument `refreshForwarding` relay, scoped to
the exact forwarding panel, to invalidate the actual singleton rule/group readers.
Refreshing a satellite display copy alone would not reload backend data. The
renderer route is implemented separately from transfer/discovery admission;
forwarding remains outside the transferable adapter allowlist pending complete
state/readiness and real native handoff acceptance.

Selected-provider discovery registers a private readiness field in a child layout
effect, before the destination's parent checks admission. Metadata loading is not
readiness: the existing capture controller also waits for the actual factory's
module import, state restoration and committed renderer, including fields added
during that wait. Explicit no-provider metadata admits the builtin surface;
discovery, import, restore or render failures reject staging rather than admitting
an error/loading shell or silently falling back. An unmounted readiness binding
rejects its original waiters and cannot be revived by late discovery. Explicit
retry creates a fresh provider factory; old rejected waits stay rejected.
The `forwarding.selection` capture field is only a null admission marker, never
plugin state, credentials or action authority. These readiness tests do not replace
real native handoff acceptance or enable the transferable adapter allowlist.

The main forwarding provider path now uses the same `plugin.factory` capture
contract for factory-only contributions. Its private selection gate waits for
the original committed view scope and child readiness before acknowledging a
source or restored view. A visible builtin recovery surface after provider failure
is not permission to capture that failure as an ordinary builtin panel. Providers
with synchronous required Workspace/Screen slots are not opted into this path.

Existing `views.register` renderers retain their original component and activation.
Their source capture requires exact per-instance state-loss consent and records
only an explicit reset, not invented empty state. If the module also exports
`createView`, that reset can open a fresh scoped destination factory without
another singleton activation. A module with no factory is still not remotely
renderable: destination staging rejects it and preserves the original source.
Full no-factory legacy presentation and real native handoff acceptance remain
required; this source compatibility guard does not claim to complete them.

A captured provider identity is also required during initial destination
selection. Deselection between capture and discovery cannot silently admit builtin
rows while discarding `plugin.factory`; the destination rejects and leaves the
source available. This obligation clears only when the matching selection has
committed its renderer (whose own factory binding still owns restoration/readiness),
so subsequent explicit user deselection of an already restored view remains valid.

### Forwarding renderer integration and native handoff checks

`renderablePanel` separates production capture/staging integration from public
movement admission. Forwarding now uses the actual `NativePanelView` interaction,
readiness, DOM/focus and checkpoint shell in both documents, but remains outside
`transferablePanel` and the native movement allowlist. A renderable view is not a
new permission to create or move a window.

Provider discovery snapshots its exact staged/owned target. A reply or failure
from a target retired during promotion is revalidated against the current target,
not applied as a new provider selection. The committed action-service lifecycle
also triggers metadata revalidation: native invalidation can arrive before the
local coordinator commits the new lease. Neither route resets the provider child.
A discovery-error Retry rechecks metadata while preserving the existing draft;
only an explicit factory-render retry replaces a failed factory. Actual current
discovery failures still block readiness/capture and never authorize mutations.

An isolated macOS check exercised the real production `SatelliteApp`, original
capture/restore and native coordinator ACK/commit for two main/native round trips.
Edited provider drafts survived both directions, the original managed SSH group
session and forwarded TCP echo remained live, and singleton activation stayed at
one. The check used explicit first-party prepare/commit, not an OS pointer drag.
It does not cover no-factory legacy views, FUSE continuity, Windows/Linux pointer
release, mixed DPI or the remaining page/provider adapters. Full parity acceptance
is still required before enabling native-window discovery or public movement.

### One-off mount snapshots and resource controls

The native-view gateway explicitly admits four existing compatibility RPCs:
`mounts.list`, `mounts.dependencies`, `mounts.open` and `mounts.unmount`. These
names do not enable a general `mounts.*` relay. Listing is a pure, plugin-owned
registry snapshot and can run during staged rendering; it does not fingerprint
packages, reap processes or probe filesystems. Dependency detection shares the
reviewed retained probe/kill/reap path and remains committed-only.

Opening a one-off mount now uses the same retained registry transaction as managed
opening, rather than listing a mount and later opening an unreserved path. Its
original plugin ID/generation must still own the exact record, and live transport,
mount identity and canonical containment are checked before launch admission.
Converted, replaced, unhealthy or another plugin's mount cannot be opened. The
registry reservation spans slow probes and the actual OS opener; closing a view,
cancelling delivery or retiring a grant cannot release an already admitted effect.
No terminal SSH session is disconnected or adopted by opening its mount.

The unmount alias uses the original admitted lease and the existing exact-origin,
invocation-fenced owned teardown. It retains the registry, nested probes and child
reaping through settlement. Existing owner/generation checks and the legacy force
argument semantics remain intact. The public v1 request/result contracts do not
change. Mount creation and browsing have separate follow-up integrations described
below. Ordinary subprocess/OS-opener test seams are
not physical FUSE or file-manager acceptance, nor complete resource-RPC parity.

### One-off mount directory browsing

`mounts.browse` now uses the same bounded, independent read-only SFTP channel as
managed directory queries. It binds the original plugin grant, invocation, native
origin and exact SSH handle; late OPEN and peer CLOSE keep the movement fence until
actual cleanup, without disconnecting the shared parent connection. The native
command compatibility entry point shares this path rather than the old unowned
listing helper. Staged native views cannot initiate this network operation.

The existing `{path, entries}` result remains a complete directory-only listing:
there is no `nextOffset`, silent first-page truncation or dependency on resolving
an unrelated home directory. Oversized/hostile replies fail explicitly. The newer
`mounts.paths.remote.browse` keeps its existing paged result. The subsequent one-off acquisition integration is described below; browsing alone
does not imply complete native-window parity.

### Beta delivery and remaining rollout

Beta delivery prioritizes working primary flows. Known P0/P1 failures (crashes,
data loss, connection/resource leaks or authorization failures) block release;
non-blocking presentation and edge-case issues can follow in patch releases.
A staged release does not mark the complete native-workspace plan finished.

The native move allowlist covers connections, tasks, output, known hosts,
forwarding, hosts, plugin lists, docked file previews and compatible sidebar plugin factories. Forwarding uses the shared
production renderer, original-window prompts and preserved provider view state;
its real macOS round-trip coverage also retained the original managed SSH session.
Unsupported views stay in their original window rather than losing state.
`viewFactories.nativeWindows` remains false until general plugin parity is ready.

Remaining rollout: ordinary terminal/SFTP/editor/settings and other panel
adapters; factoryless plugin presentation; remaining resource APIs;
and physical cross-window dragging across desktop platforms, displays and DPI.
Continue these as follow-up implementation/acceptance work, without treating them
as completed or requiring every non-blocking detail before a useful Beta.

### Forwarding native-window delivery

Forwarding now exposes the same new-window and existing-window move actions as
the other admitted panels. Both TypeScript rendering/movement and native creation
allowlists opt in explicitly. This does not loosen staged resource admission,
prompt/effect movement fences or general plugin nativeWindows discovery. The
existing capture/stage/commit path retains drafts and promotes the same restored
provider tree; unsupported legacy providers can still reject a move without
retiring the source. Physical cross-platform dragging remains follow-up acceptance.

### Native one-off mount acquisition

`mounts.mount` now has a committed-only native call policy. It keeps the frozen
request/result shape and original plugin lease, invocation, document/view origin
and exact authenticated SSH handle. Path preparation and startup use bounded,
retained workers; filesystem validation does not block the renderer/runtime.
Failed readiness or final admission awaits cleanup of the exact registered mount.
An unreceived startup result also owns cleanup, including child reaping and SSH
channel CLOSE settlement, without disconnecting the borrowed parent session.

Only successful startup publication releases the creating call's channel fence;
the mount then belongs to the registry and can survive view movement. Dropping a
failure-path release callback does not release that fence. Existing managed mounts
share the same owned transport. Real loopback SSH tests cover transport traffic,
accepted-resource detachment, failed-startup CLOSE and a usable sibling channel;
ordinary subprocess tests cover lost-result cleanup. These are not a real FUSE
mount or cross-platform native UI acceptance claim. General native-window parity
and the other adapters listed above remain follow-up work.

### Preview coordinator and view state

The main preview owner, above `PreviewFrame` and `NativePanelView`, now publishes
both the existing public metadata registration and a separate host-only active
read registry. Removing a presentation body must withdraw neither registration nor
its exact local/SFTP read. The private window publisher serializes resource/model
updates and coordinator restarts, deduplicates unchanged resource publications,
and follows only the current read source. Native snapshot notifications do not
feed back into model publications. The underlying ticket appears only in the
main-only resource command, never the model, public observation or view capsule.

Text content stays in the private read model, not the <=1 MiB view-state capsule.
The preview model alone permits 16 MiB serialized JSON: a <=2 MiB decoded file can
expand sixfold when escaped. Other model/capsule limits are unchanged. Read/decode
failures use a fixed display message rather than serializing arbitrary native
exceptions. Markdown mode, PDF page/zoom, and audio/video position/volume/mute/rate
have explicit attempt-qualified capture bindings. Text caret/scroll and PDF/Markdown
scroll use the common DOM geometry markers; staged text never takes focus.
Restored media is paused and cannot autoplay during staging. The shared display
renderer now consumes supplied data/services without acquiring file resources;
its readiness stays pending for spinners and waits for real content/load/render.

### Native preview presentation

Docked previews opt into the same explicit new-window/return flow as other native
panels. Main retains the source and publishes the endpoint model before admitting
a presentation child; a private acknowledgement prevents discovery from racing an
absent model. Satellites render the injected text/media/PDF data through scoped
read-only handles. `createView` restores provider drafts without singleton replay;
the same provider Body and staged handle survive promotion. Temporary frozen
selection discovery cannot unmount a retained draft. Readiness retries retired
bindings only if live replacement bindings exist; removing a pending renderer
still rejects the original wait rather than acknowledging an empty panel.

Every effect rechecks the preview ID, attempt, revision and native lease at main.
Provider actions require `ui.trusted`, `filePreview.read` and the host-selected
`fs.read`/`sftp.read` endpoint grant; mutations also require `filePreview.write`.
Providers cannot forge renderer ready/decode/edit reports. A successful close/edit
may receive only its empty acknowledgement after self-removal, never data from a
replacement lease or reloaded document. Media stages paused, captures playback
intent, and attempts resume only after commit/rollback; OS autoplay policy may
still require the user's Play gesture.

macOS acceptance used the production SatelliteApp and preview body for four actual
local roundtrips (text, image, PDF, audio), unchanged source/ticket identity,
provider drafts, PDF page/zoom, paused audio position, native provider retry and
isolated plugin/session cleanup. It is not remote-SFTP, physical pointer dragging,
cross-platform or FUSE acceptance. Quick Look remains main-local: returning a
satellite directly into Quick Look is explicitly unsupported; return to main first.
Local Quick Look/panel state continuity and broader workspace rollout remain
follow-ups, not reasons to claim general `nativeWindows` support.

### Native host-list presentation

Hosts use the shared tree/table renderer and a private display-only read model.
The projection explicitly enumerates metadata; credentials and connection routes
are not serialized. The closed native action grammar accepts opaque host/group
incarnation markers, not raw hosts, settings patches or arbitrary IPC commands.
Main re-resolves targets after revealing itself and again at destructive
confirmation, rejecting edited, removed or recreated targets.

Search, group collapse, focus and supported factory-provider drafts travel in the
view capsule. Main owns credential, SSH-config and import/export dialogs outside
the movable list. Satellite actions reveal those dialogs in main rather than
bootstrapping another application owner. Host-list factories require no synchronous
workspace slot and now receive the same main-window factory adapter as forwarding
and task providers. Factoryless providers remain on the existing compatibility path.

macOS acceptance covered actual builtin and factory-provider window roundtrips,
search/collapse, favorite writes, table/sort actions, main-owned export-dialog
opening, singleton activation count and isolated plugin/host/session cleanup.
It is not real SSH, physical pointer drag or cross-platform acceptance.

### Native plugin-list presentation

The plugin browser has one shared renderer and an explicit metadata-only model.
No runtime IDs, fingerprints, grants, frontend module descriptors, download URLs,
archive hashes, readmes or Node runtime configuration are published. Source URLs
and installed paths remain intentional display hints. Search, tag, scope and page
use the view capsule; the main store remains compatible with detail-page navigation.

Native commands accept closed operations and opaque catalogue/installed-entry
incarnation markers. Main re-resolves after revealing itself and at installation
confirmation; changed/removed entries and cross-source installs are rejected.
The actual archive URL/hash and installation authorization stay main-owned.
Local installation dialogs live outside the movable browser, so moving the list
does not discard an archive inspection or install draft. Detail/settings actions
reveal main; this adapter does not claim native detail-page/settings support.

### Native host metadata reads

The exact `hosts.snapshot`, `hosts.sourcesSnapshot`, `hosts.routes.get`,
`hosts.routes.observe` and `hosts.getFields` methods are staging-safe retained
reads. Saved snapshots recheck read authorization outside the DB guard; route
and own-field queries use their existing authorized, bounded admission workers.
Discovery snapshots only clone bounded in-memory metadata. Schema-change reports
do not migrate or write field values. Original plugin grants, generation, view
origin and call lifetime remain checked by the native gateway, including after
worker settlement; dropping a caller does not prematurely release the move fence.

No prefix/get-name inference: host mutations, imports/exports, SSH-config access,
column/decorations publication, credentials and connection APIs are not admitted
by this change. General `viewFactories.nativeWindows` remains false. Existing
reader cancellation/revocation tests and native policy/lifetime tests are not a
claim of actual SSH/FUSE or cross-platform UI acceptance.

### Terminal session handoff foundation

`beginTerminalHandoff` atomically reserves only the requested, deduplicated
sessions before asynchronous preparation. Reservations cover all preparations,
including cancellation: a late detach cannot run after rollback. Check
`isCurrent()` before native ownership transfer, then `commit()` only after the
destination owns the stream. A committed source must never reattach, even if it
has already unmounted. Idempotent rollback retries only failed original
participants, not replacements registered under the same ID. Background suspension
owns a separate batch; resume notifications cannot steal another pending handoff.

The private terminal JSON codec explicitly maps undefined character sets, tab
stops and private modes to reversible null fields, including charset-array holes.
Restore supplies xterm's undefined values rather than JSON nulls. Version, shape,
byte, node and depth checks run before teardown/restore; oversized snapshots are
refused, never truncated. Panel transport is limited to 1 MiB; background retains
the existing 64 MiB budget and native aggregate limit. Background snapshot v2 uses
this codec and still reads v1. Screen/input drafts remain ephemeral in memory,
never in preferences, logs, the plugin bus or public discovery.

This batch integrates background restoration and exercises the actual distributed
xterm parser across JSON, Unicode packet boundaries, alternate buffers, charsets
and keyboard modes. It does not enable terminal native windows. Document/panel-
leased native PTY endpoints, main-owned actions/shared resource handles, the page
adapter and real SSH window acceptance remain required.

### Native terminal stream endpoint

The private `panel_window_terminal` broker lets only main bind an existing,
published, user-managed PTY. Plugin/dedicated background connections are ineligible.
Binding captures the exact writer channel instead of resolving/reconnecting by ID.
A dynamic `terminal:` prefix alone is not transferable: it requires a live resource
bound by the current coordinator document. Removing a panel retires the binding,
not SSH. A session that entered native presentation must reattach through a new
native presentation lease, never fall back to the unleased legacy subscription.

Attach uses a dedicated Tauri Channel, not the plugin bus or public screen events.
Each output packet checks the exact document/panel/generation and resource instance
under the same ownership guard as delivery. A staged destination cannot attach.
Detach returns the actor's output-sequence barrier; the destination attaches only
after commit, restoring its screen and registering its listener first. Revoked or
failed sinks retain exact bytes in a bounded buffer without advancing sequence or
replaying accepted packets; full buffers apply SSH channel backpressure. Legacy
unleased attach cannot steal an established private presentation stream.

Write/resize/detach revalidate origin both at admission and actual actor execution.
Admitted effect fences survive IPC receiver loss, queueing and the actual SSH
write; failed queue admission never automatically retries input. This gateway does
not expose hosts, credentials, connection creation/disconnection or arbitrary IPC.
Client disposal only retires its local listener, not a late detach capable of
stealing a successor's stream.

This batch supplies the endpoint and host-private client. Tests exercise a real
local SSH protocol/PTY actor across sink handoff, stale-input rejection, sequence
replay and retained connection. This is not actual native-window or user remote-
server acceptance. Terminal page/settings/provider/resource lifetime integration
remains pending; the terminal window entry stays hidden and general nativeWindows
support is not claimed.

### Terminal renderer services and close replay

`TerminalPageView` is the shared production renderer. Its coordinator wrapper
supplies local services; a window adapter must supply its own read-only terminal
preference source, exact-scoped I/O/event listeners, checkpoint registry and
main-owned UI actions. The explicit preference projection excludes provider
grants, proxy profiles and unrelated writable settings. Parser readiness is
reported after font loading, checkpoint restoration and listener registration,
before attachment; a staged adapter may wait for committed ownership in attach.
View/lease failure must not disconnect the original PTY.

Panel captures carry `checkpoint` versus `move` intent. They cannot share an
in-flight capture across intents: periodic input/scroll saves never authorize a
resource detach to remain held for transfer. Legacy unspecified captures retain
checkpoint semantics. An adapter must still implement commit/rollback of an
actual move; this distinction alone does not enable terminal native windows.

When a remote shell closes while detached, its actor retains queued final bytes
for up to 60 seconds, covering the bounded native handoff. It refuses new remote
input/resize, accepts authorized replay attachment, then performs normal session
cleanup only after successful drain. A rejected sink retains bytes until a valid
attach or expiry; explicit user close still tears down immediately. This is a
bounded in-memory handoff buffer, not persistent terminal-history storage.

### Production terminal native-window adapter

Builtin terminal tabs now use the same production renderer in main and satellite
windows. Main binds an existing PTY before first render, publishes explicit
read-only session/preferences, and retains display metadata after shell exit until
tab close. The destination restores its parser before ownership-gated attachment;
a move holds its checkpoint reservation until native commit or rollback. Main
owns disconnect, file/history navigation, clipboard and opted-in command recording.
Requests cannot select another host/session or patch unrelated preferences.

The ordinary tab menu exposes native window moves, and satellite tabs compose the
same local workspace/floating frame and native return actions. A selected terminal
interface provider currently blocks outgoing native moves; returning to main is
always allowed. Selection changes while away show an explicit recovery banner,
not a silently substituted provider. General public nativeWindows discovery stays
false.

Isolated macOS acceptance used the actual SatelliteApp and a local SSH server:
one authentication and one shell across native roundtrip, partial command input
continued in the destination, ANSI/Chinese/emoji screen retained on return, stale
source input rejected, and test resources cleaned. Physical cross-window pointer
dragging, mixed-DPI Windows/Linux and arbitrary remote servers are not covered by
this acceptance.

A naturally closed, still-open terminal tab retains a transferable render-only
binding. This does not reopen the PTY or grant write/resize authority after exit.

### File-page resource boundary

`SftpPageView` is the shared production file renderer. Its required
`FilePageServices` supplies explicit session/host/file-preference read models,
filesystem operations, workspace/clipboard/search/preview effects, plugin menus,
provider surfaces, native file drops and shortcut routing. The main-only wrapper
provides the existing store/IPC services; a satellite must supply leased services
and must not hydrate writable main stores. Breadcrumb child-folder reads use the
same supplied backend, not an implicit global filesystem. `createFileSystem`
routes every operation through its supplied backend and never retries a rejected
operation through main IPC.

This separation preserves the current main file-page behavior. It does not yet
admit SFTP tabs to native windows: exact native resource registration, effect
fences, scoped actions/provider integration, state handoff and actual SSH/SFTP
window acceptance are still required. Keep the entry hidden until those pieces
are connected; do not substitute a read-only demo for the full file workflow.

### Native file-page renderer

Live file tabs now register an explicit native resource and use the same
`SftpPageView` in main and satellite documents. `FilePageServices` injects
per-call owned/staged targets; staging permits directory reads only. The owner
publishes serializable preferences, source metadata and plugin descriptors;
highlight indexes cross the wire as entry arrays, not JavaScript Maps. Satellites
do not hydrate main stores or gain an arbitrary IPC fallback.

Create, rename, remove, copy and transfer use the scoped native broker. Transfer
origin fences survive the returned task ID through actual worker settlement.
Editor/preview navigation, clipboard, search roots, plugin menu execution and the
real remote-source chooser stay with main. Menu/mount clicks rediscover current
contributions and source authority before execution. Confirmation holds an exact
native interaction, and disposal cleans its dialog and transfer subscriptions.
Only derived source/root metadata is deferred during staging, never user effects.

File view state includes selection, filters, navigation and inline drafts; stable
DOM markers capture supported scroll/focus/caret state. Readiness waits for the
actual listing/error render rather than an empty shell. Main and native file and
terminal pages share `NativeWorkspaceFrame`, not parallel floating chrome.
Selected file-browser interface providers currently stay in main; if one becomes
selected after a move, the satellite provides a return-to-main action. This does
not claim general `viewFactories.nativeWindows` support or complete native
coverage for editor, host-detail, settings or legacy factoryless plugin pages.

Isolated macOS acceptance exercised the actual `SatelliteApp` with a localhost
SSH/SFTP server: explicit window roundtrip retained filter and selection, editor
navigation reached main, old-generation mutation was rejected, and scoped
mkdir/create/rename/copy/upload/download/delete completed. The single successful
SSH authentication was retained and QA hosts/sessions/known-host entries were
cleaned. A separate chooser check reused the existing connection in main. This
is not physical pointer, mixed-DPI, Windows/Linux, FUSE or arbitrary-server
acceptance. A nonblocking transient validation toast during return is tracked for
later polish; it does not prevent ownership transfer or file operations.

### Native text-editor renderer

Editor pages use the production `EditorPageView` with an injected owner boundary.
The main document alone owns the file resource, baseline, conflict checks, undo
history and plugin execution. Native IDs are short, explicitly admitted
`editor-view:<UUID>` identities, not file paths. Satellites receive a private
read model rather than hydrating main editor or plugin stores.

Satellite input is optimistic and batched as ordered source-text patches, with
exact document/version/output-encoding checks before a whole batch is applied.
Save, undo, formatting, encoding and conflict review drain pending input first.
IME commits as one undo transaction and blocks movement while composing. The
handoff capsule contains caret/selection/scroll only; text and history remain
with main, and readiness requires the actual editor or error render. A stale
publication cannot overwrite newer pending input. If an external edit conflicts,
the rejected draft is copied to a separate main-owned recovery document before
movement is allowed; failed recovery retains the local draft and movement fence.
Neither path overwrites the externally changed document.

Only explicitly registered editor models and actions get the larger bounded
JSON-escaped document budget; the general view-state capsule stays at 1 MiB and
queued action data has a separate aggregate bound. SFTP and editor tab menus use
the standard native move actions. Host-detail/settings and factoryless plugin
pages still require their own adapters; this does not enable general native
plugin factories or establish cross-platform pointer/FUSE acceptance.

Isolated macOS acceptance used the actual `SatelliteApp` with local files and a
localhost SSH/SFTP server: dirty buffers survived roundtrips, undo/redo and their
caret focus worked without an extra click, keyboard encoding selection changed
the dirty remote draft to UTF-16 LE and saved bytes decoded identically, and
local edits saved through the native window. Old-generation mutations were
rejected, there was one SSH authentication across both moves, and isolated
hosts/sessions/known-host entries were cleaned. Physical pointer/mixed-DPI,
Windows/Linux and real plugin-formatting/conflict-dialog flows are not covered
by this native-window acceptance; their contract/component tests are separate.

### Native host-detail pages

Builtin host details share `HostPageView` and explicit effect services. Main
registers opaque `host-view:<UUID>` identities, including for long discovery IDs;
registration is independent of prefix recognition and expires on main-document
replacement. The satellite receives only the selected host's display metadata
and forwarding rules, groups and session summaries. Host actions revalidate both
the bound host and its display incarnation; editing, deletion consent, copies,
credentials and terminal/SFTP navigation stay main-owned. An existing normal SSH
session is reused for file navigation, never a forwarding/mount-only session.
Forwarding uses the existing native interaction/effect fences and additionally
checks canonical rule/group ownership against the bound host.

First-party forwarding forms use the same view-state group on both sides, so
in-progress rule/group drafts can travel with the page. Legacy host fields,
host-detail contributors and selected forwarding providers currently keep the
page in main: they have no complete movable draft contract yet. Enabling one
while the page is detached freezes its first-party controls without discarding
the draft and offers return to main. This is an explicit rollout limitation,
not permission to silently omit a contributor or replay singleton activation.
Settings and factoryless plugin pages remain separate rollout work. Physical
pointer/mixed-DPI, Windows/Linux and live SSH/FUSE continuity require separate
acceptance; this adapter does not claim those checks or a general public API.

### Settings renderer boundary

`SettingsPageView`, `PreferenceFieldsView` and `PreferenceRowView` use explicit
document-local data/effect services. Main composition retains the real profiles,
consent, plugin providers and specialized settings sections. This extraction does
not admit settings to native windows: every custom section and draft/effect path
must be adapted before exposing that entry; it is not a whole-store IPC proxy.

Specialized preference controls (themes, file icons, host-list defaults, CSS and
updates) also expose owner-independent renderers. Theme/color and host-list
merges remain in the owner so an old displayed snapshot cannot overwrite newer
unrelated values. CSS chooser/export, update installation and diagnostic
navigation are explicit effects. Numeric inputs, custom update-source drafts and
release-note expansion accept document-local view-state hooks; the native
adapter must supply capture-aware hooks instead of recreating singleton stores.
The terminal preview accepts the existing read-only terminal preference source.
Profiles, proxy credentials, storage migration, shortcuts and plugin-provider
sections still require complete adaptation before settings can move natively.
