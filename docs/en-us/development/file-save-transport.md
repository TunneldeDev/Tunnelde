# Native file-save transport (experimental)

[Development](README.md)

The internal `ssh/files/native_save` adapter consumes the optional helper's
`files.save.v1` protocol. It is separate from legacy SFTP cleanup and runner
control. It does not install a runtime, advertise support, enable desktop saves,
or add a public plugin API. Installation consent, editor integration and recovery
UI must be accepted before enabling this path. The private durable service is
implemented, but remains dormant until those flows are integrated.

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
The submit client requires a single-use permit from the private recovery journal;
the service obtains it only after recording possible dispatch durably.

`journal/` separates the record contract, database lifecycle and revision-CAS
transitions. Its dedicated `native-file-saves/recovery.sqlite3` database is under
the configured database location. Existing missing, corrupt, foreign or replaced
storage is rejected without recreation. SQLite uses `synchronous=EXTRA`; reserve,
ready, possible-dispatch, receipt and cleanup-intent changes are short transactions.
The storage inventory carries the entire directory through moves and resets;
moving the database without its data is refused when recovery storage exists.

The journal persists original owner/generation, authenticated destination, helper
selection, authority and intent, but never file content or the control token.
`secrets` uses a distinct application-scoped keyring service, including isolated
QA identifiers. The service first reserves a record, then saves and verifies its
unique token, then marks readiness. A missing, changed or inaccessible token never
causes rotation or a replacement operation. No keyring deletion is exposed.

After possible dispatch, only original-operation status is used for recovery.
Missing remote state remains unresolved. Retained records reserve their target
until confirmed release; at most 128 records and four potentially active workers
are admitted. Unknowns are never evicted. Cleanup intent is persisted before
release, including the exact receipt revision and explicit backup-discard choice;
a lost release reply is recovered by status rather than a second release request.
Owner admission and live transport checks remain required immediately before
dispatch. The service does not settle legacy SFTP unknowns.

Tests execute a specifically selected reviewed helper, checking native create,
replace, exact duplicate, client reconstruction, cancellation tombstones and
revision-bound release. The historical helper is tested separately and remains
unsupported. Independent canonical hash vectors and malformed/authority-change
cases complement actual producer/consumer tests. These checks do not substitute
for authenticated SSH disconnects, desktop process restarts, installation consent,
physical-platform acceptance, or legacy SFTP unknown settlement.
