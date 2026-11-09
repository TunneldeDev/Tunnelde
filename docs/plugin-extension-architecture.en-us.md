# Extension architecture

[简体中文](plugin-extension-architecture.zh-cn.md) · [API compatibility](plugin-api.en-us.md)

Extensions are organized by domain, with six review dimensions: contract, runtime,
data, presentation, behavior and governance. This is the architectural direction,
not a claim that all domains already implement every extension capability.

## Discover implemented capabilities

Call `api.describe` to inspect available RPC methods, permissions and stable
contracts. If `extensions.describe` exists, its experimental response describes
implemented runtime UI extension points. It returns a version, stability, six layer
identifiers, domains with RPC namespaces, and points with IDs, domains, layer,
stability, combination policy, registration methods, ownership, permissions and
limits. Treat unfamiliar fields and point types as unknown capabilities.

The directory currently lists host decorations, status items and tab controls.
`composition: "merge"` means registrations from different owners combine according
to that point's documented ordering. `ownership: "runtime"` means the registration
is tied to an approved plugin instance, not persisted application data. Domain
namespaces classify real methods; they do not imply a public dependency injector,
complete domain services, remote execution availability or a permission grant.
The host checks directory references against real methods and permissions in tests.

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
listeners. This is internal lifecycle infrastructure, not a published UI SDK or a
sandbox for directly loaded frontend code.

## Domain boundaries

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

## Trusted frontend components: planned boundary

The intended UI SDK will allow trusted frontend modules to compose public host
components and provide views or a complete workbench. Modules will share a supported
React runtime, declare UI SDK compatibility and use public service accessors.
This loader and complete workbench replacement are not implemented by this directory.
Do not import internal source paths or assume a component ABI exists yet.

Code loaded directly in the host frontend shares its JavaScript context. It is not
an operating-system, DOM or native-bridge sandbox; error boundaries cannot stop
infinite loops or undo arbitrary side effects. Such modules require explicit trust,
a host-owned recovery path and an option to start without frontend extensions.
Credentials, host-key trust and permission decisions remain host-owned flows.
Existing executable Node permission checks likewise do not sandbox Node itself.

Stable RPC contracts remain supported during migration. New directory and host-list
methods are experimental. SDK synchronization, historical plugin compatibility,
real lifecycle/permission tests and platform validation are required before widening
the stable surface. Full migration alone does not establish v1.0 readiness.
