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

At most eight native blocking read/open workers may be queued or running together.
Capacity belongs to the worker until it exits, even when its async caller times out
or closes. Cancelled queued workers skip IO; a reader waiting for its cursor lock
checks cancellation again after acquiring the lock. Already running filesystem IO
can still finish. Saturation returns an explicit busy error without queuing more
work. One byte read is bounded to 32 MiB, preserving existing whole-image previews;
HTTP ranges remain capped at 1 MiB. Text-prefix reads retain the caller's existing
limits and read one extra byte to detect oversize input. Files may change through
other writers: these handles do not promise a consistent immutable snapshot.

This native service adds no public RPC or plugin authority. Full public content and
preview resources require separate lifetime, permission, transport and SDK contracts.

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

The stable editor APIs and experimental buffer compare-and-swap contracts are
unchanged. File mutation ownership, durable write settlement, cross-source moves
and a complete shared file data/subscription contract remain separate work.
