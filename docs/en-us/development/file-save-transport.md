# Native file-save transport (experimental)

[Development](README.md)

The internal `ssh/files/native_save` adapter consumes the optional helper's
`files.save.v1` protocol. It is separate from legacy SFTP cleanup and runner
control. It does not install a runtime, advertise support, enable desktop saves,
or add a public plugin API. Installation consent, durable desktop journaling and
recovery UI must be integrated and accepted before enabling this path.

The adapter has separate contracts, codec, client and transport modules. Shared
POSIX/PowerShell command encoding lives under `ssh/command`; it never includes
content or private control tokens. Requests use bounded stdin, a single absolute
transport deadline and a combined stdout/stderr bound. Closing an SSH channel
cannot prove that a remote worker stopped. Failures distinguish an unsent
request from a possibly dispatched one without echoing remote output.

Before sending any private control, the transport compares the original host
key, authenticated account and canonical scope with the selected connection.
Saved host settings cannot redirect recovery. The response must match the full
original authority, root and private-state identities, operation, generation,
intent digest and binding. Unknown protocol fields/states, malformed receipts,
changed authorities, stale revisions and nonzero/missing exit status are rejected.
`live: null` and `backupRetained: null` remain unknown; no truthy/falsey conversion
may authorize cleanup.

Clients explicitly initialize, submit, query, cancel or release. A failed submit
never triggers an automatic second submit. Restore uses the original authority
and status operation without initializing remote storage. Release requires a
known receipt, original executor exclusion, exact revision and explicit backup
discard when a backup exists. It is distinct from generic cleanup permission.
A request accepted by this adapter is not proof of durable desktop journaling;
the caller must persist its original control before dispatch.

Tests execute a specifically selected reviewed helper, checking native create,
replace, exact duplicate, client reconstruction, cancellation tombstones and
revision-bound release. The historical helper is tested separately and remains
unsupported. Independent canonical hash vectors and malformed/authority-change
cases complement actual producer/consumer tests. These checks do not substitute
for authenticated SSH disconnects, desktop process restarts, installation consent,
physical-platform acceptance, or legacy SFTP unknown settlement.
