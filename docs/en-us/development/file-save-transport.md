# Native file-save transport (experimental)

[Development](README.md)

The internal `ssh/files/native_save` adapter consumes the optional helper's
`files.save.v1` protocol. It is separate from legacy SFTP cleanup and runner
control. It does not install a runtime, advertise support, enable desktop saves,
or add a public plugin API. Installation consent, editor integration and recovery
UI must be accepted before enabling new writes. The desktop lifecycle can load
existing recovery records and project explicit recovery actions into background
tasks. Installation, initialization and the actual editor save path remain disabled.

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
possible-dispatch, receipt and cleanup-intent changes are short transactions.
Credential setup and deletion retain an immediate write transaction until the
actual keyring call returns. This cross-process exclusion prevents retirement
from removing a reservation while setup can still write its credential.
The storage inventory carries the entire directory through moves and resets;
moving the database without its data is refused when recovery storage exists.

The journal persists original owner/generation, authenticated destination, helper
selection, authority and intent, but never file content or the control token.
`secrets` uses a distinct application-scoped keyring service, including isolated
QA identifiers. The service first reserves a record, then saves and verifies its
unique token, then marks readiness. A missing, changed or inaccessible token never
causes rotation or a replacement operation. Explicit finalization durably abandons
never-dispatched work or retires a confirmed released record before removing its
matching credential and record. Unknown writes and retained backups cannot be
forgotten this way. OS-keyring lookup/deletion is not a CAS against arbitrary
external writers; operation keys must never be reassigned.

All journal/keyring operations run on bounded blocking workers. Caller cancellation
does not return a slot while its actual disk/keyring work is still running. The
desktop manager opens existing storage lazily; once observed, a missing or failed
store remains an error rather than becoming an empty first run. Listing recovery
records does not read credentials or contact the remote host. A historical live
receipt is shown as requiring attention, never as proof of current execution.

Recovery tasks offer query, discard-unsent or finish-local actions and a software
log link. Query selects a live connection matching the original authenticated
destination and checks only the original operation. It does not install, initialize,
submit, cancel or discard a remote backup. Legacy local, legacy remote and native
stores are read independently so an inaccessible store cannot hide the others.
Existing native recovery reservations are checked before legacy editor saves,
transfers, create, rename, delete and retained-artifact cleanup. The shared path
comparison includes ancestors/descendants, Windows drive spellings and literal
POSIX backslashes. Original helper executables and private state directories
are protected while recovery depends on them. Potential host aliases are matched conservatively by captured
address, saved host ID or authenticated key; exact identity is still required for
recovery. Canonical SFTP resolution checks existing paths or the closest existing
parent, with bounded probes and a deadline. Corrupt/inaccessible recovery storage
rejects mutations while browsing and diagnostics remain available. An absent
first-run store is not created by these checks.

This is protection for existing records, not bilateral mutation admission. New
native reservation entry points are compiled only for tests. Before enabling new
saves, a durable broker must atomically exclude active and unresolved legacy
writes in both directions, with the actual worker retaining ownership through
cancellation and process loss. A read/check before a network await is insufficient
when new reservations can be admitted concurrently. The current checks do not
fence arbitrary external filesystem writers or prove symlink identity survives a
later mutation. They do not settle unknown legacy SFTP requests.

The internal version-2 journal adds legacy mutation claims in the same SQLite
authority. Format upgrade is explicit and transactional; reopening version 1
does not upgrade it. Both namespaces share the 128-record and four-dispatched-worker
limits. Native and legacy admission check each other under `BEGIN IMMEDIATE`,
including original helper state and ancestor paths. Claims retain the captured
destination, requested/canonical paths, owner generation, revision and dispatch
checkpoint. Only the original worker receives a single-use settlement permit;
ordinary retirement cannot delete a potentially dispatched claim. A lost result
remains an attention task with logs, without offering an unsupported remote query
or discard action.

Remote create/mkdir/rename/delete and editor save/retained cleanup workers use
this internal authority when an explicitly upgraded store exists. Frontend
delivery timeout does not cancel an already admitted primitive mutation: its
worker observes the original operation for up to five minutes. Primitive workers
track each original mutation request separately. A recognized terminal SFTP
rejection releases its claim while preserving the operation error; it does not
prove that no partial filesystem changes occurred. Transport loss, timeouts,
malformed responses and uninstrumented composite-operation failures retain the
claim. A later successful request cannot settle an earlier unknown request.
Read-only preparation failures do not invent a pending mutation. Editor claims
are released only after confirmed staging cleanup and removal of the original
recovery record; recording a deferred cleanup is not completion. Exact recovery
continuation and plugin revalidation at the final dispatch boundary still require
completion before production enablement.

Production initialization and full transfer/artifact enrollment are not enabled yet, so this
does not establish complete bilateral coverage or enable native editor saves.
Unknown historical SFTP outcomes are never attested by a newly installed helper.

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
