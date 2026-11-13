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
recovery record; recording a deferred cleanup is not completion.

When every original request has a recognized terminal reply, the original worker
may park its exact editor claim for cleanup. The legacy receipt stores that
claim's journal and operation identity. A continuation must match the original
owner/generation, authenticated destination and lexical/canonical paths; a
transactional revision check admits only one resumed worker. Cancellation keeps
the original reservation. Every cleanup mutation persists its own possible-send
checkpoint before submission. A lost cleanup reply remains unknown even when a
later probe finds the directory absent; a new cleanup attempt cannot erase it.
Only confirmed cleanup and removal of the original receipt release the claim.

Plugin create, mkdir, rename and delete workers retain their original runtime and
request authorization. After the durable possible-dispatch checkpoint, they
re-resolve reserved lexical/canonical paths, check the authenticated destination,
and admit cancellation and authorization before polling a mutation. Recursive
delete and directory merge recheck authorization before each later mutation,
after awaited read-only preparation. Revocation stops subsequent steps; it does
not undo an already admitted request or partially completed operation. Closing an
already admitted file handle still observes its original completion. Preparation
or final admission failure releases a claim only when no mutation was polled.

The internal transfer adapter can reserve all mutated remote endpoints in one
transaction. A live transfer can extend its exact reservation with generated
staging or backup paths before using them. Extension retains the original owner,
authenticated endpoint and existing paths, checks all competing native and legacy
reservations in the same transaction, and advances the dispatch revision. It
neither locks unrelated siblings nor grants permission to submit a request.
Losing extension delivery leaves the older settlement permit stale and the
expanded reservation intact. Each claim remains bounded to four scopes and 32
stored paths; this is not an unbounded directory-transfer inventory. Transfer and
artifact-cleanup paths now use this reservation; complete mutation-boundary and
desktop lifecycle coverage remain required.

The private transfer continuation retains the journal/claim identity, task owner
and generation, exact revision and immutable original roots. The private journal
stores these roots independently of the caller's continuation reference.
Generated paths may extend a claim but cannot become new task roots; a caller
cannot shorten a multi-path task either. Older internal transfer records without
recorded original roots remain reserved and cannot adopt roots from a new caller.
Before parking or settlement, the original attempt atomically closes its request
epoch, and can do so only
after every observed request and writable handle is settled. Old queued raw,
buffered and compressed writers are then rejected before submitting a mutation.
A resumed attempt revalidates the original authenticated endpoints, roots and
generated-path coverage under a bounded resolution timeout, wins the exact
durable dispatch revision and receives a fresh request epoch. Preparation or
cancellation cannot release the parked claim; uncertain original requests keep
it dispatched. A temporarily pending reply does not consume the original worker:
it retains its permit and may park only after observing that reply. A sealed
attempt cannot extend paths, park or settle a second time. Persisted task
association now ties this state machine to transfer run and artifact cleanup;
remaining lifecycle boundaries below still gate production enablement.

Actual range channels now share one in-memory observation per transfer, including
parallel directory workers, compressed channels, archive writes and detached
staging-directory creation. Each raw SFTP mutation is observed before its error
is mapped for presentation. A writable OPEN retains a separate handle receipt
until its original successful CLOSE; rejected CLOSE, channel shutdown or a later
successful write cannot release it. The compressed protocol worker tracks original
request ids and validates mutation-reply shapes before delivery, so it can observe
a late terminal reply even after the caller cancels. Unretained raw SFTP requests dropped by
their caller remain unknown because the library no longer delivers that response
to the observer. Pseudo connection statuses are not terminal MKDIR rejections.
Ordinary metadata-channel writable files and transfer-directory creation share
the same observation as the range workers. Writable OPEN remains owned until
its own successful CLOSE, including empty staging files and resumed writers.
Buffered write/flush/close failures are retained conservatively because the
high-level file adapter exposes IO errors rather than typed SFTP replies.
Cancellation before directory creation creates no mutation receipt; cancellation
after dispatch waits for the original MKDIR reply. Dropping that wait retains
uncertainty even when a later metadata probe sees the resulting directory.
The runtime transfer registry now owns the request epoch used by metadata and
data workers. Publication rename, atomic replacement, staging-file unlink and
staging-directory removal observe typed original replies before mapping errors.
An unexpected extension packet cannot acknowledge a replacement. Completion or
result-cache eviction retains unconfirmed epochs independently; re-registering
the same task cannot forget them. Cleanup atomically seals the previous settled
epoch before obtaining a new one, excluding queued old adapters. A late original
reply can permit that transition; an unrelated probe or later success cannot.
Publication, recovery rename, atomic replacement and artifact cleanup now retain
their original protocol workers after cancellation or expiration of the caller's
wait. Transfer and cleanup teardown cannot close an owned metadata channel while
that worker remains live. Its original typed terminal reply can settle the request;
transport shutdown, malformed replies and protocol timeouts still remain unknown.
Runtime retention complements the durable task/claim association; the private
journal governs crash recovery independently of result caches. Final mutation
authorization and complete lifecycle coverage remain required. Restarting the
application does not establish completion of an unconfirmed transfer.

The private transfer claim can now bind an immutable task ID and operation intent
in its creation transaction: both endpoint paths, authenticated remote identities,
copy/move and overwrite options, and plugin ownership. Generated-path extensions,
parking and continuation preserve that original intent. A task lookup after
reopening requires an exact match; historical unbound claims cannot adopt a task
from application history, and a dispatched claim cannot be replayed. An absent
claim is not a terminal receipt; only an original-worker terminal claim authorizes
the local projection handoff described below.

The transfer run and explicit artifact-cleanup paths now admit the original
private task using the registry's own request epoch. A synced application-store
reference is written before dispatch; it cannot replace the private task or
authorize a replay when that private record is missing. Registry release retains
the actual original permit, including while a detached protocol request awaits
its reply. A subsequent cleanup attempt can park that permit only after the
original epoch settles. Staging and backup paths enroll through that same permit;
nested copy destinations recheck admission after read-only preparation. Task
projection checks reject a remote/local switch or a changed host/address, and
plugin workers recheck their live authorization lease. Request guards retain the
same registry epoch and task instance while checking cancellation, plugin runtime
generation and authenticated peers before new remote writes. The compressed wire
writer rechecks after queueing; retained metadata workers recheck after spawning.
Local range writes recheck after remote reads, and local publication rechecks
inside its blocking worker. Original admitted responses and handle flush/CLOSE
can still complete after revocation; denial cannot manufacture terminal evidence
or erase an outstanding handle. This is partial lifecycle
integration. Successful bound runs and confirmed artifact disposal now seal the
original request epoch and persist a terminal claim before syncing the task
projection. Its original scopes remain blocking until that projection and its
reference commit together at FULL durability (or a stronger existing setting),
then exact-revision retirement removes the claim. Projection failure retains the
private terminal for local-only retry. Startup/list recovery can reconstruct a
missing task row from the immutable private intent; a changed application path,
host, options or plugin owner is rejected. Completed/cancelled tasks cannot resume,
and a stale application reference cannot recreate a missing private claim.

Known-unsent transfers can be disposed without remote writes only after checking
that no artifact or progress metadata remains. Previously dispatched or parked
tasks cannot use missing application artifact records as disposal evidence. The recovery entry also
uses terminal projection rather than directly dropping bound transfer claims.
Physical process-death tests cover private completion, uncommitted transitions,
application projection and retirement across two actual SQLite files. These
checks do not replace complete desktop lifecycle acceptance. Copy cleanup uses
the immutable original source intent without requiring the source peer online;
move cleanup still revalidates its mutated source. Complete mutation-boundary
coverage remains required. No production
enablement is implied.

Host-owned disposal has a separate runtime phase after the original request
epoch is sealed. It preserves the original task and plugin attribution, checks
the current immutable application projection and destination identity, and does
not create or reactivate a plugin lease. Ordinary transfer authorization rejects
this phase. With a private transfer permit, disposal may validate only paths
already covered by that permit, including canonical spellings; it cannot enroll
new scopes from application artifact records. Component integration tests cover
an offline copy source, an invalidated plugin runtime, an actual SFTP artifact
unlink, terminal projection and claim retirement. They do not substitute for
desktop cancellation, disconnect and restart acceptance.

The recoverable editor phase is part of the internal, explicitly initialized v2
candidate format; it is not a public plugin API or an automatic storage upgrade.
An interrupted possible dispatch without an original terminal receipt still
retains a conservative reservation. Terminal projection can recover locally;
unknown remote outcomes remain unresolved, and complete desktop lifecycle
acceptance remains a production enablement gate.

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
