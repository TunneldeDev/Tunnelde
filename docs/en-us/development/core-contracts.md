# Core contract closure for 1.0

The desktop application owns its domain services. Tauri commands, local
automation and plugin RPCs are adapters to those services; their protocols and
permissions are distinct. A working internal command is not automatically a
public API. The application version does not silently promote an experimental
method to stable.

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

## Automated evidence

`scripts/ci/check-core-contract.mjs` checks the historical stable plugin floor.
`scripts/ci/check-local-api-contract.mjs` validates actual local-domain producer
outputs against the finite stable declaration, discovery schema and unchanged
historical fixtures. `src-tauri/tests/automation_cli.rs`
runs real console and desktop CLI subprocesses against a fixed v1 wire fixture.
These checks do not replace actual desktop service integration or packaged
cross-platform installation and upgrade tests.
