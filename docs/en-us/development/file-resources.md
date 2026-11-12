# File read and preview lifetimes

The editor and built-in/provider previews share host-owned read lifetimes under
`src/lib/files/resources/`. `target.ts` captures immutable request coordinates;
`read.ts` adapts text reads; `preview.ts` owns native preview tickets and bounded
text assembly. They reuse the extension runtime's `ResourceScope` implementation.
They do not define a second cancellation engine or add public plugin methods.

A target preserves the exact path and either local access or an explicit SSH
session ID. It is not a canonical file identity, alias resolver, permission grant,
snapshot, or authority to delete a file. Mutating a caller's source object cannot
retarget an already requested read.

Disposal stops delivery and requests cancellation. Native IPC may still be in
flight; its scope reservation stays occupied until the actual promise settles.
Consumers also fence results against the current document or preview activation.
Closing a view never implies that a filesystem write stopped or rolled back.

## Preview ownership

Local preview ranges, built-in text previews and plugin local text reads use the
shared native reader in `src-tauri/src/services/files/read/`. It resolves intentional
aliases, then opens a regular file with platform flags that reject final symlink,
reparse and special-file replacements. It retains the opened handle and serializes
seek/read pairs. Windows readers permit an existing log writer to continue writing;
the editor's more restrictive publication handles remain separate. Ancestor path
resolution still follows the OS and does not establish a filesystem sandbox.

At most eight native read/open workers may be queued or running together, shared
by local blocking IO and remote protocol IO.
Capacity belongs to the worker until it exits, even when its async caller times out
or closes. Cancelled queued workers skip IO; a reader waiting for its cursor lock
checks cancellation again after acquiring the lock. Already running filesystem IO
can still finish. Saturation returns an explicit busy error without queuing more
work. One byte read is bounded to 32 MiB, preserving existing whole-image previews;
HTTP ranges remain capped at 1 MiB. Text-prefix reads retain the caller's existing
limits and read one extra byte to detect oversize input. Files may change through
other writers: these handles do not promise a consistent immutable snapshot.

The native service itself grants no plugin authority. The separate public content
resource boundary below owns its permissions, lifetime and bounded transport.

Remote previews use the same source service, with a dedicated read-only SFTP
channel and opened handle. Each READ carries an explicit offset and exact bounded
length; there is no mutable prefetched cursor. Short replies continue from the
returned byte count, without reading beyond the requested range. The service
honors negotiated packet/read limits, rejects empty or oversized DATA replies,
and validates the opened handle's regular-file type and reported size.

Cancelling a caller keeps its actual worker reservation until the pending protocol
request settles; it then skips subsequent requests and discards delivery. A late
OPEN acknowledgement closes its abandoned channel. A read error or whole-read
deadline closes only this dedicated channel before releasing admission. This
preserves the user's parent SSH connection. At most 64 source channels, including
pending opens and retained workers, may exist. Opens are bounded to 15 seconds,
individual replies to 15 seconds, and whole reads to 30 seconds.

SFTP v3 does not provide local `O_NOFOLLOW` guarantees or control over a server's
blocked filesystem operations. Closing a channel requests remote resource release;
it does not prove that server-side OS IO stopped. These sources pin handles, not
immutable file contents, and grant no authority independently of the public resource boundary.

Each provider preview gets a fresh host-generated ticket ID. Closing while native
provider discovery is pending requests early close; a late successful open is
closed again because registration can happen after the early request. Cleanup
always uses the requested ID, never an unvalidated returned ID. Normal successful
opens retain the ticket until the view closes or its renderer fails.

Before reading, the adapter checks the returned ID, selected renderer and safe
integer size against native renderer limits: text/Markdown 2 MiB, images 32 MiB,
PDF 128 MiB and audio/video 1 TiB. Text uses at most 1 MiB per range, assembles one
bounded buffer and validates UTF-8 and NUL bytes. Open, metadata, range, decoding,
PDF and media errors start immediate ticket cleanup. Retry uses a new ticket.
Changing language does not reopen a working preview.

These retained file handles do not promise an immutable filesystem snapshot. The
existing native preview registry, I/O limits and remote-session checks remain
authoritative. A cleanup request does not prove native cleanup succeeded.

## Editor requests

Opening, closing, disconnecting or superseding a read invalidates its delivery.
Concurrent reconnects follow the latest explicit intent. An interrupted initial
load records that no baseline was read; reconnect can then fill the document
without a false conflict or an endless loading state. Text typed while disconnected
is retained. A previously loaded draft still requires explicit review when the
remote baseline changes. Older in-memory checkpoints infer baseline availability
from their existing loading/error fields.

Save coalescing binds a document generation and exact promise. A replaced document's
old write cannot block a new save, clear its pending operation, update its baseline
or emit a stale error. Typing while saving remains dirty. An in-flight write is not
cancelled, replayed or rolled back when the document is replaced. Existing native
baseline checks remain necessary; this lifetime layer is not a write transaction.

Local editor saves and retained staging cleanup share four actual-worker slots,
independent of the eight reader slots. Admission occurs before dispatch to the
blocking pool. Excess calls fail with `editor.saveBusy` before file IO; the caller
keeps its draft and may retry after current operations finish. A cancelled caller
does not release a running or queued worker's slot. Pool-queued cancelled jobs
skip IO; started saves recheck cancellation after the path lock and before
publication. Cleanup admitted on a worker finishes its safe transaction even if
its delivery is cancelled. A published save still sends its committed change
notification; cancellation cannot roll it back. Worker failures return
`editor.saveWorkerFailed`, with domain/stage diagnostics in application logs.
This budget does not forcibly interrupt OS IO or settle remote write side effects.

Remote editor saves and retained staging cleanup have a separate four-worker
budget, acquired before opening SFTP channels. `editor.remoteSaveBusy` rejects
excess work while preserving the draft; unexpected worker termination returns
`editor.remoteSaveWorkerFailed`. The owned worker retains its path lock and
cleanup reservation after the caller stops waiting. Cancellation is checked after
waiting for the path lock and before staging/publication. An acknowledged owner
marker allows safe staging cleanup even when the caller has disappeared.

Publication admission and cancellation have one atomic winner. After admission,
the worker waits for the rename result and safe cleanup, without retrying or
rolling back that rename because delivery was cancelled. An acknowledged save
emits its file-change notification on the worker exactly once; IPC routing does
not emit it again. No-op saves reconcile observers without requiring replacement
support from the server. A cancelled cleanup caller also leaves its admitted
cleanup worker running until the transaction settles.

Local plugin saves use the same runtime, exact request and client admission fence
as remote saves. Blocking workers recheck after acquiring the path lock and after
scoped target/hash validation. Cancellation and publication admission have one
winner, including no-op reconciliation. No filesystem IO runs under the policy
lock; after admission, the atomic filesystem replacement and cleanup settle even
if the caller is cancelled or the plugin is stopped. Admission does not provide
filesystem compare-and-swap against unrelated processes.

Remote plugin saves recheck the exact runtime grant, client/request lifetime and
SSH connection after the path-lock wait, before staging and at publication
admission. Scoped AI/MCP writes retain the approved canonical path, original path
alias, authorized root alias and content digest on the worker, and re-resolve them
before admission. Cancelling an exact tool request also fences its admitted worker
even before the caller task processes its cancellation. The final synchronous
runtime/client gate orders admission against revocation; no policy lock spans
network IO. After admission the asynchronous rename and safe cleanup settle once,
and an acknowledged publication still notifies observers if delivery is cancelled.

These bounds concern client worker lifetime and publication admission. SFTP
timeouts and lost replies do not prove that server-side work stopped. Network
path validation and rename are separate server operations, not compare-and-swap;
external processes may race them. This does not add a public write transaction API.

Remote editor recovery persists a versioned generation and operation intent with
SQLite FULL durability before creation, serialized staging mutations and final
publication. Terminal replies settle the corresponding intent. Transport errors
and timeouts retain an unknown result; neither missing paths nor matching bytes
settle it. Cleanup and subsequent saves of that remote target are blocked while
its result is unknown. Old records without receipts are preserved conservatively.
Recovery reloads the current record after reservation, and stale revisions cannot
overwrite or resurrect retired journals. The host allows 128 retained records;
capacity exhaustion rejects a new save before remote mutation.

This is the conservative SFTP recovery floor. Automatic resolution of missing
replies after process loss requires separate server operation fencing or durable
receipts. It does not silently install a helper, retry a rename or authorize
recursive cleanup. Acknowledged publication notifies once even if recording the
terminal receipt fails locally; the unknown recovery record is retained.

The stable editor APIs and experimental buffer compare-and-swap contracts are
unchanged. File mutation ownership, durable write settlement, cross-source moves
and a complete shared file data/subscription contract remain separate work.

## Public read-only content resources (experimental)

The `files.content` API provides bytes to ordinary frontend or stdio plugins without
host preview ticket IDs or an implicit SSH target. `prepare` takes an explicit
`{source:{kind:"local"},path}` or `{source:{kind:"remote",sessionId},path}` and
checks only the corresponding `fs.read` or `sftp.read` grant. Paths are absolute.
Preparation reserves an empty descriptor for 20 seconds and performs no file IO.
`open` claims its returned `contentId` exactly once. The SDK knows this ID before
IO starts, so cancellation can close it even if the open response is lost. A close
that overtakes open removes its prerequisite; a late success cannot reinstall it.
Unknown preparation responses own no file or channel and expire.

`read` accepts safe integer byte offsets and lengths from 1 to 49152, clamped at
the opened size. Results contain canonical base64, decoded byte count and EOF.
The SDK validates these fields and returns `Uint8Array`. The opened size must fit
JavaScript's safe integer range. Handles pin file identity, not an immutable content
snapshot; truncation or modification can change or fail subsequent reads.

Use `createFileContentClient` from `sdk/files/content/client.mjs`. Pass an owner
`AbortSignal` to `open`; aborting that owner or calling the returned `close()`
retires the resource. Each client and host runtime permit eight handles; the host
permits 64 in total, sharing the native eight-worker IO admission. Reads renew a
60-second idle lease; `observe` and `subscribe` observe lifetime and do not renew it
or watch filesystem changes. Deadlines reject operations immediately; a single
host sweeper reclaims idle handles within the next second. Close is idempotent.
Native worker permits remain held until actual IO settles after cancellation.

Descriptors and opened sources participate in `resources.snapshot`,
`resources.identify({kind:"fileContent",id:contentId})` and `resources.release`.
Every operation checks runtime ownership independently of IDs. Runtime stop,
permission revocation and restricted mode retire its handles. Releasing an opened
resource may report `cancellationRequested`: retiring a dedicated SFTP channel or
local handle is not proof of stopping already-running OS IO. Parent SSH connections
remain intact. Scoped AI tool allowlists are unchanged pending separate handle and
path-scope contracts. Public preview lifecycle and presentation have their own
[experimental contract](plugins/file-preview.md); mutation transactions remain
separate work. These methods do not expand the stable API set.
