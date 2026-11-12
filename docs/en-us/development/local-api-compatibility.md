# Local API compatibility

The first local stable candidate is limited to seven methods. It remains
**experimental** until release acceptance and a reviewed stable declaration are
complete. Existing stable plugin RPC promises are independent; desktop 1.0 does
not automatically stabilize other plugin, runner or UI extension APIs.

| Method                 | Contract boundary                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------- |
| `api.describe`         | Protocol, methods, input/result schemas and error/exit metadata for this binary                   |
| `app.info`             | Application/protocol version, OS and architecture                                                 |
| `hosts.list`           | Saved native hosts: public IDs, group ID, name, address, port, username, favorite and tags        |
| `sessions.list`        | Published live SSH connections, including background connections; `terminal` identifies terminals |
| `preferences.schema`   | Versioned public preference groups and validation schemas                                         |
| `preferences.snapshot` | Current values, defaults and opaque revision                                                      |
| `preferences.update`   | Conditional update through the desktop's shared settings writer                                   |

## Data and lifetime

Host IDs identify saved records, not authorization grants. Deleting a host ends
that identity. Session IDs identify a connection lifetime; reconnection may
produce a new ID. `connectedAt` is Unix time in milliseconds. Lists are
point-in-time observations and can become stale immediately. Separate calls do
not share a transaction. List ordering is unspecified; consumers should sort.
Plugin-supplied host sources are outside `hosts.list`.

Preference revisions are equality tokens, not sortable counters, timestamps or
event cursors. Obtain a fresh snapshot before writing and handle `stale_revision`
explicitly. A revision can change even when the fields a client displays appear
unchanged. Defaults describe this application version and may evolve. Partial
object updates preserve unspecified fields; collections replace their previous
contents according to the public schema.

The local protocol has no subscriptions, durable event replay or cancellation
method. Poll snapshots as needed. Closing a connection or timing out is not a
rollback: a write may have committed even if its response was lost. Read again
and reconcile; request IDs provide correlation, not deduplication. Do not
automatically replay timed-out writes. The local API does not expose arbitrary
native commands, shell execution, credentials or remote listening.

## Stable declaration rules

A stable declaration names the protocol and finite method/schema baseline.
Compatible releases preserve method names, required request fields, accepted
input values, output types and meaning, error codes/exit mapping, permission
boundaries and write semantics. Optional input fields, new methods or ignorable
output metadata can be additive. Requiring a previously optional field,
narrowing accepted input, deleting output or silently changing meaning is
incompatible.

Consumers validate required output types and protocol versions, ignore new
response fields, and use the documented fallback for unknown error codes.
Human-readable messages, localized labels and array order are not machine
contracts. Schemas describe the current producer: strict producer
`additionalProperties: false` checks must not cause historical consumers to
reject future additive output fields. Implement `x-maxBytes` when validating.

Breaking stable changes require a new protocol/domain contract version and an
application major release. A replacement must provide a migration path; the
previous protocol remains supported throughout the current application major
line. Deprecation must appear in discovery and paired docs with the replacement
and earliest removal version. Behavior remains supported until that boundary.
Experimental changes still need release notes and existing-client review.
Preference changes must review the independently versioned preference contract
as well as the local adapter.

## Release evidence

Stable review requires frozen input/result/error fixtures, actual producer
validation, an older real CLI against the current host, platform CI, packaged
CLI execution, installer/upgrade data retention and migration rules. Historical
consumer fixtures remain immutable; new versions are added alongside them.
Schema equality tests are regression evidence, not proof of every behavior or
platform. See [local API usage](local-api.md) for the execution boundary.
