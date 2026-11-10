# Extension architecture

[简体中文](plugin-extension-architecture.zh-cn.md) · [API compatibility](plugin-api.en-us.md)

Extensions are organized by domain, with six review dimensions: contract, runtime,
data, presentation, behavior and governance. This is the architectural direction,
not a claim that all domains already implement every extension capability.

## Interface source organization

Group interfaces by domain first, then separate contracts, service orchestration, persistence,
transport adapters and presentation according to their actual responsibilities. The six layers
are review dimensions, not a requirement to create six files for every small module. Shared
infrastructure contains domain-independent events, resource scopes and synchronization.

Forwarding DTOs and validation live in `services/forwarding/contract.rs`, persistence in
`repository.rs`, SSH startup admission in `runtime.rs`, and service entry points in `mod.rs`.
Native IPC uses `commands/forwarding.rs`;
the plugin adapter uses `plugins/api/domains/forwarding/mod.rs`. SSH listeners and relaying remain in the
transport module. Both adapters call the domain service. Frontend contracts, shared state and
views are also separate. Moving files does not change existing RPC names, permissions or wire
shapes. SDK and documentation entry points should follow domain boundaries; older modules
have not all migrated yet.

The RPC boundary in `plugins/api.rs` owns request authorization, payload limits and response
reauthorization. `api/routing.rs` only selects adapters and publishes the existing committed
domain invalidations. Adapter implementations live under `api/domains/<domain>/`; file
adapters separate local operations, SFTP, owned transfers and atomic text publication.
Connection DTOs and bounded SSH execution also have separate files. The request/reply bridge
to frontend commands lives in `api/transport/frontend.rs`, independently of business logic.
Tests live beside their owning implementation; cross-domain frozen contract fixtures remain
shared. These internal module paths are not new plugin RPC namespaces.

Public UI types live under `src/lib/extensions/contracts/<domain>/`. Their SDK mirror and
the RPC declarations in the marketplace repository follow the same domain boundaries.
Compatibility entry files re-export the historical names. Generators validate the public
dependency graph and historical consumers; do not copy private application stores into the SDK.

Host-side UI bridges follow the same domain boundaries under `src/lib/extensions/`:
`files/context.ts`, `terminal/bridge.ts` and `history/context.ts` own their data adapters;
each domain's `provider.ts` owns its authorized callback facade. Shared provider lease
and access types live under `runtime/providers/`. `ProviderSurface` selects the renderer,
checks its current identity and recovers to the built-in view; it does not implement
domain actions. These private modules are not new public SDK entry points.

The native forwarding feature separates `model/` DTOs, payloads and address helpers,
`data/store.ts` shared invalidation, `runtime/useForwardingController.ts` operation
orchestration, and `components/` rows and editor. The section composes them while keeping
the controller mounted throughout editing. This separation prepares the forwarding UI
provider; it does not itself expose a new provider or complete its ownership contract.

## Discover implemented capabilities

Call `api.describe` to inspect available RPC methods, permissions and stable
contracts. If `extensions.describe` exists, its experimental response describes
implemented UI extension points. It returns a version, stability, six layer
identifiers, domains with RPC namespaces, and points with IDs, domains, layer,
stability, combination policy, registration methods, ownership, permissions and
limits. Treat unfamiliar fields and point types as unknown capabilities.

The directory currently lists host decorations, host menus, status items and tab controls.
`composition: "merge"` means registrations from different owners combine according
to that point's documented ordering. `ownership: "runtime"` means the registration
is tied to an approved plugin instance, not persisted application data. Domain
namespaces classify real methods; they do not imply a public dependency injector,
complete domain services, remote execution availability or a permission grant.
The host checks directory references against real methods and permissions in tests.
Manifest contributions use `registration.manifest` and `ownership: "manifest"`;
their metadata can be displayed before an approved runtime is started.
[Host menu commands](plugin-host-menu.en-us.md) use the same consent, stale-target
checks and output handling as file menu commands.

[Host decorations](plugin-host-list.en-us.md), [status items](plugin-status-bar.en-us.md)
and [tab controls](plugin-tab-bar.en-us.md) use the shared runtime-owned registry.
Frontends subscribe before requesting a snapshot, reconcile revisions, release
listeners on unmount and fence queued reads/events after authorization changes.
This mechanism is independent of a particular view or Zustand store.

## Runtime resource ownership

The frontend's internal resource scope owns subscriptions and asynchronous work.
`use` registers an existing cleanup; `acquire` reserves capacity before opening a
resource and retains its cleanup; `run` releases its reservation when work finishes.
Acquisition/work can have a caller cancellation signal and a deadline. Parent abort
or scope disposal promptly rejects outstanding callers even if their underlying
operation ignores cancellation. A late acquired resource is cleaned up instead of
being delivered. Cancellation does not roll back native or remote side effects.

Cancelled work keeps its quota reservation until the underlying operation settles.
Pending asynchronous cleanup also consumes capacity, preventing repeated retries
from accumulating work outside the limit. A successful acquisition belongs to the
scope: its acquisition deadline and caller signal no longer close that resource.
Its acquisition signal is aborted when the scope releases it.

Disposal is idempotent, aborts the lifetime and starts registered cleanup in reverse
order. It observes and reports synchronous/asynchronous cleanup failures but does
not wait for asynchronous cleanup or force uncooperative work to finish. The default
scope limit is 128. Invalid limits and deadlines are rejected before work starts.
Closed, caller-cancelled and timed-out operations have distinct error codes.

Host decoration, status item and tab control synchronization use this ownership
mechanism. Listener initialization and each snapshot read have a 30-second deadline.
A read timeout leaves subscriptions available for a later refresh; expired reads
cannot replace current content. An initialization failure releases partial and late
listeners. These scopes also support the experimental UI SDK; they do not sandbox directly
loaded frontend code.

## Domain boundaries

RPC method discovery is organized under
`src-tauri/src/plugins/api/catalogue/<domain>/methods.rs`. Its composition module
only owns catalogue metadata and assembly; routing, authorization, domain services,
persistence and SSH transport remain separate responsibilities. Existing wire
method names, permissions and compatibility metadata are preserved. A historical
catalogue fixture compares complete method contracts by name; discovery order
is presentation detail. The SDK reader checks every composed domain and rejects
unknown entries, duplicate methods, missing files and unreferenced domains.

Discovery declarations, RPC adapters and SDK types are each grouped by domain in
their own layer. Existing SDK entry points remain compatible exports. UI declarations
are separately classified under `src/lib/extensions/contracts/<domain>/`. This source
organization does not mean every domain has completed its service or extension migration.

Public data must use protocol DTOs, not expose arbitrary internal state. Operations
must pass through domain services and repeat authorization at execution time.
An execution location is distinct from the location of the target resource.
Cancellation, undo, compensation and atomic transactions require different contracts;
a cancelled remote operation may already have produced effects.

Saved hosts and groups now use one native domain service from both application
commands and plugin RPC. It owns input normalization, persistence, session-name
updates, credential cleanup, audit records and post-commit invalidation. Host
removal and its saved connection route are deleted in one database transaction;
reordering is also atomic. Failed writes do not publish success notifications or
forget credentials. The existing RPC request and result shapes remain unchanged.
This is the first extracted domain, not a claim that all native commands have
already been migrated.

Each implemented extension point must state whether contributions merge, select a
provider or replace a view. Priority alone does not resolve all conflicts. User
choices govern view/workbench providers and existing shortcut conflict behavior.
Plugin storage and additional data fields require plugin namespaces and schemas.

## Trusted frontend components

The experimental [UI SDK](plugin-ui.en-us.md) loads explicitly approved local ESM
modules with the host React runtime and public components. Modules declare their
SDK range and register manifest-declared component views and commands. Approval
binds the package snapshot and runtime generation; stopping or revoking a plugin
removes owned contributions and rejects old transport URLs and calls.

Frontend code shares the host JavaScript context and native bridge. It is trusted,
not sandboxed; error boundaries cannot interrupt loops or undo arbitrary effects.
The host retains its authorization, credential and recovery interfaces. Complete
workbench replacement and the remaining domain migrations are still pending.

Existing stable RPC contracts remain compatible. New extension discovery, host
annotations and the UI SDK are experimental. Extending stability requires SDK
synchronization, old-plugin regression tests and real platform acceptance.
