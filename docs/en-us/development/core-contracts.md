# Core contract closure for 1.0

The desktop application owns its domain services. Tauri commands, local
automation and plugin RPCs are adapters to those services; their protocols and
permissions are distinct. A working internal command is not automatically a
public API. The application version does not silently promote an experimental
method to stable.

## Credential ownership

Host, proxy and plugin secrets use the application-owned vault injected through
`AppState`. The keyring service is the configured application identifier.
Production keeps `dev.tunnelde.app`. Existing host/proxy secrets remain readable
through an explicit legacy binding until changed or forgotten. New saves use
immutable random OS item names and publish a database binding after confirmation.
Isolated
applications use their own service and never fall back to production credentials.
Changing the data directory alone does not isolate OS credentials; QA builds must
also use a distinct application identifier. Instances with the same identifier
intentionally share that credential service. This naming boundary is not an OS
access-control boundary against other programs running as the same user.

Native-save recovery tokens keep their separate, application-derived service.
Public transports cannot select a vault service or change the application's
identifier. No credential values enter API discovery, logs or snapshots.

Private desktop `host_editor_save`, `proxy_profile_save`, `credential_status` and
reviewed connection credential operations share bounded blocking workers for OS
credential access and retirement. Their shared budget admits at most 16 operations, including queued work;
overload returns `credentials.busy`. Cancelling the command future before worker
admission prevents a queued operation from starting. After admission, the worker retains
capacity until OS access settles; losing the reply does not roll back a write.
Original host/profile, route and trust authority, binding revision and underlying
OS errors remain part of the operation. Host fields and route commit atomically;
proxy fields commit with their binding authority. Editors receive committed
fields even if the following credential operation fails, and retain the editor
for retry against the same host/profile. Status still reads the bound credential
and can require OS authorization. These desktop commands do not add stable API methods.

Schema migration 6 stores no secret values. Short database transactions own item
intents, CAS publication, configuration incarnations and exact-item retirement.
No database/settings/route authority guard spans OS access. A stale write cannot
publish its item or delete a replacement item's secret. Forget publishes a
tombstone before deferred deletion; it never falls back to a legacy key. Host or
profile destination changes discard implicit credentials, while cosmetic edits
preserve them. Relevant route, proxy selection and trust A→B→A changes revoke old
authority; unrelated selectors and display edits do not. Password publication
changes the binding revision without invalidating its own SSH prompt review.

After exclusive storage ownership, startup recovers bounded metadata pages before
workers start. Failed OS writes retain their original unknown intent; cleanup
addresses only the retired item, does not replay a save, and retains failed claims
for restart recovery. All native readers use these bindings; plugin secrets keep
their existing namespace and authorization. This is not an atomic transaction
with external OS edits, and copying a database does not create an independent
credential namespace when both copies use the same OS service. Future-schema
databases must be refused by older builds rather than silently downgraded.

Windows and macOS CI explicitly run the binding lifecycle against their real OS
credential stores using random QA services. The default-ignored fixture checks
schema-5 migration, replacement, cross-process reads, durable forget, unpublished
item recovery and exact cleanup without deleting a neighboring service. Its child
has a 60-second deadline and its CI step a three-minute deadline. This hosted
test does not prove installed-app Keychain authorization, physical user prompts,
or the cause of a reported desktop freeze.

The reviewed SSH saved-password fallback shares this worker budget. Its original
route snapshot and credential-host scope are checked at actual worker admission,
after the read and again before authentication uses the result. No database guard
spans OS access. A changed review discards the read result instead of refreshing
the user's review or authenticating against edited configuration. This read-only
boundary shares the immutable binding repository with reviewed writes/deletes;
their original configuration checks run before OS mutation and publication.

Preparing the desktop SSH review also uses this bounded worker capacity because
capturing the transport can read an authenticated proxy's saved password. The
displayed host is checked against current storage when the worker actually runs,
before proxy credential access; queueing does not refresh a stale dialog. Shared
route capture checks saved connection inputs and dynamic source scope before
transport inspection, then keeps its complete post-read verification. Database
locks are released before OS access. A concurrent edit can still require discarding
a completed read. Other review operations retain their existing authority and
scheduling rules.

HTTP proxy credential reads and client construction for updates, release history,
the marketplace and helper downloads share the bounded credential workers. A check
captures its network settings once; discovery, backoff identity, manifests and the
retained package updater use the same resolved proxy. Existing source/channel
generation checks still govern publication. Cancelling a marketplace download
while preparation waits prevents its later GET; an already admitted OS read can
continue holding capacity until it settles. The history deadline includes route
preparation and preserves selected notes when history is unavailable. No TLS,
signature or explicit-proxy fallback policy is relaxed. System clients can be
reused for up to 30 seconds; their backoff identity stays with that client.
External OS proxy/secret changes are not observed as an atomic OS transaction. Other
credential consumers retain their separately documented boundaries.

Native proxy diagnostics resolve the selected TCP route on the same bounded
workers before connecting. The 15-second TCP budget includes route preparation;
a timed-out or abandoned preparation cannot dial when its OS read finishes late.
The three quality samples reuse one resolved route. The optional HTTPS test has
its own 15-second budget including worker-based client construction, and keeps
TLS verification and the selected proxy. Saving a connection route validates
proxy selection and URL fields without reading a saved password. This does not
change the separate authority rules for reviewed credential mutations.

The recovery browser's probe, trust, connect and final open perform slow OS
proxy inspection before retaining registry, connection or recovery metadata
guards. Their native observation is opaque and cannot be supplied over IPC.
Final effects match the same pending object and original recovery token, then
check persisted hosts, routes, known keys and effective SSH proxy configuration.
The durable settings row is authoritative even before its in-memory publication;
malformed stored settings reject admission rather than silently using defaults.
Unrelated profiles and display names do not revoke an operation. Trust advances
only the approved endpoint and aliases without another OS read inside the guard.

Open reserves an existing connection while preparing asynchronously. A competing
busy request cannot cancel its owner. Cancellation, failed or dropped acceptance
retires only the matching pending object and closes its newly acquired private
connection; reused user-owned sessions retain their separate ownership. No OS
transaction is promised for external proxy or credential changes: the observed
transport precedes the final pure configuration check. Reviewed credential
writes/deletes retain their separate mutation authority and immutable-item CAS;
the browser observation alone is not authorization for a credential write.

Plugin engine and local process-task proxy environments are prepared on the same
bounded credential worker, outside the runtime thread. Initial and final database
admission yield on mutex contention and share the preparation deadline instead of
blocking behind a credential writer. Effective plugin/process proxy selection is captured from persisted settings before queueing and checked
again before applying the native environment. Direct and system inheritance retain
their existing meanings. A local task's deadline includes preparation; cancellation,
revocation or expiry during preparation prevents late launch admission. After
preparation, the original runtime grant and cancellation are checked immediately
before spawning, without an intervening await. This is prelaunch admission, not
an OS transaction with external credential changes or concurrent revocation after
admission; launched children retain their existing owned cleanup rules.

## Compatibility rules

- A stable interface has an owned request/result/error schema, documented effects
  and lifetime, a compatibility fixture and a real producer/consumer test.
- Within the same major contract version, required input fields cannot be added,
  accepted inputs cannot be narrowed, existing outputs cannot be removed or
  reinterpreted, and error codes cannot change meaning. Additive output fields
  require consumers to tolerate them before being introduced.
- A revision is opaque and identifies a persisted generation. Writers use the
  original revision; stale edits fail rather than overwriting newer settings.
  A retry is not a new authorization and cancellation is not rollback.
- Events are invalidations unless their contract explicitly promises delivery.
  Consumers must be able to reconstruct state from a snapshot. Reconnection and
  window recreation do not imply that an old plugin/runtime owner is authorized.
- Errors expose a stable code and safe public details. Diagnostic messages can
  evolve. Logs must identify the domain/stage without exposing credentials.
- Deprecation is discoverable and documented. A replacement and migration period
  precede removal in a new major contract. Existing stable plugin-v1 guarantees
  remain in force; CLI-v1 does not replace them.

## Domain ownership and release gates

The stable local protocol v1 surface is limited to these seven methods.
The versioned declaration and immutable historical baselines are documented in
the [compatibility policy](local-api-compatibility.md):

| Surface                                                            | Contract boundary                                                                                                                                                                                  |
| ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `api.describe`, `app.info`                                         | Protocol/method discovery and running build identity; offline CLI discovery describes its own build, not the host                                                                                  |
| `hosts.list`                                                       | One saved-host snapshot through the shared host service; no credentials, mutation or plugin-provided hosts; array order is unspecified                                                             |
| `sessions.list`                                                    | One live connection snapshot; IDs identify connections rather than durable hosts; a returned connection may disconnect immediately; `connectedAt` is Unix milliseconds; array order is unspecified |
| `preferences.schema`, `preferences.snapshot`, `preferences.update` | Public settings only; opaque revision, strict partial field updates, whole collection replacement and stale-write rejection; no migration or credential access                                     |

Snapshots do not reserve resources or promise event delivery. The local protocol
is request/response; it exposes no event stream. Preference commits still publish
the application's normal invalidation event internally. Lost replies to writes
are ambiguous: re-read the snapshot and inspect the result rather than replaying
with a fresh revision automatically. Local callers already run as the same OS
account; the capability grants this limited surface without plugin permissions
or an interactive approval prompt.

The existing 16 stable plugin methods retain their separate frozen contract.
Additional local mutations, plugin UI extensions, runners and advanced transfer
recovery can remain experimental after desktop 1.0. They are not required to
reach the first stable local contract. Release gates continue to include historical
client compatibility, supported-platform binary checks, basic file safety, and
actual installation/upgrade data preservation. A new API method is not a gate.

This table is a closure checklist, not a claim that every domain is stable.
The [local API](local-api.md) is the first external-program adapter.

| Domain               | Existing owner                                                          | Closure required before promising its public stability                                                                             |
| -------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Discovery and errors | `automation/contract.rs`, plugin catalogue and historical core fixtures | Version negotiation, authentication, bounded framing, exact result/error exclusivity and historical consumer                       |
| Hosts                | `services/hosts.rs`                                                     | Independent public DTOs; validation, audit, rename and invalidation preserved across adapters                                      |
| Connections          | `ssh/session.rs`                                                        | Explicit connection/host identity, trust/auth flow, disconnect and cancellation semantics; no credential-bearing result            |
| Preferences          | `services/settings/preferences/`                                        | Frozen public schema, revision conflicts, validation/effects ordering and restart requirements; internal Settings excluded         |
| Profiles and storage | `settings_profiles/`, `storage/`                                        | Export/import limits, migration/recovery and data preservation; incomplete recovery stays experimental                             |
| Forwarding           | `services/forwarding/`                                                  | Persisted rule revision distinct from runtime connection identity, accurate disconnected state and shared validation               |
| Files and tasks      | `services/files/`, `ssh/files/`                                         | Basic copy/move/cancel/reconnect, safe source retention and cleanup; unknown side effects cannot be inferred from missing paths    |
| Diagnostics          | `logs/`, `platform/logging/`                                            | Bounded pages, domain attribution, cursor/filter and redaction rules; diagnostics do not become a reliable audit stream implicitly |
| UI and extensions    | `src/lib/extensions/`, domain bridges                                   | Existing stable promises remain; advanced contributions and remote runners may remain experimental for 1.0                         |

Do not expand RPC counts as a substitute for closing these boundaries. Do not
make every plugin or advanced transfer recovery mechanism a prerequisite for
the first stable desktop release. Basic file safety, actual installation and
upgrade preservation remain necessary even when advanced features are deferred.

Native local listing, directory creation, file creation and deletion use the
bounded `services/files/local.rs` worker adapter. The eight queued or running
operations retain capacity until actual filesystem work settles. Cancellation
before admission prevents a late mutation; cancellation after admission does
not roll it back. Existing filesystem behavior and errors remain shared with
the synchronous domain implementation. Plugin calls retain their immediate
authorization-to-operation boundary; they do not enter this native queue.

## Automated evidence

`scripts/ci/check-core-contract.mjs` checks the historical stable plugin floor.
`scripts/ci/check-local-api-contract.mjs` validates actual local-domain producer
outputs against the finite stable declaration, discovery schema and unchanged
historical fixtures. `src-tauri/tests/automation_cli.rs`
runs real console and desktop CLI subprocesses against a fixed v1 wire fixture.
These checks do not replace actual desktop service integration or packaged
cross-platform installation and upgrade tests.

The public-package CLI checks also compare the discovery emitted by each 1.0
candidate or later package with the frozen local v1 baseline, including method
metadata, input/result schemas, transport and errors. Earlier 0.x packages remain
valid upgrade sources without claiming that stable declaration. The package
report records whether the stable floor was verified; seven successful calls
alone do not establish it.
