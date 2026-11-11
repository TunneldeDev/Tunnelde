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
