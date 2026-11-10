# Command history

Command history is saved locally per saved host, with at most 500 entries. A repeated
command moves to the top. Listing defaults to 200 entries; the requested limit is
clamped to 1–500. Empty commands and commands exceeding 4000 UTF-8 bytes are ignored.
The existing history RPC remains experimental; this service consolidation does not
promise a complete shell history, a paged snapshot or a lossless terminal recording.

Automatic terminal capture requires the user's **Record terminal history** opt-in.
It is a best-effort interpretation of terminal input, not shell integration. Passwords
and other sensitive text can appear in raw input; leave recording disabled when it is
inappropriate. Leading-space input is skipped by the automatic capture path.
An explicitly approved plugin with `history.write` can save history through the API;
that explicit API is separate from automatic capture. Never put secrets in history.

The native UI and plugin RPC share `services::history`. The service returns an independent
transport DTO `{ id, hostId, command, executedAt }`, preserving existing field names.
`executedAt` is milliseconds since the Unix epoch. `history.list` requires `history.read`;
`history.record`, `history.delete` and `history.clear` require `history.write`.
Authorization remains in the transport. A successful record requires an existing saved
host. Delete and clear remain idempotent, and return `null` over plugin RPC.

Successful native and plugin mutations emit `plugin://domain-changed` with
`{ domain: "history", hostId, sessionId: null }` after commit. A failed write, ignored
record, absent deleted row or empty clear emits nothing. Delete resolves its owning host
and removes the row in the same transaction. No command text is included in invalidation.
The workbench bridge invalidates only panels for the affected host; legacy events without
`hostId` still invalidate all history panels. Browser integrations retain the existing
local `tunnelde:history-changed` event. Native UI code does not emit a duplicate local event
after the same mutation.

Panels load all retained entries (up to 500), collapse concurrent invalidations into
one trailing read and ignore late results from previous hosts or lifetimes. Events are
invalidation hints, not durable delivery acknowledgements. A new panel always loads
fresh data. The [experimental history provider](plugin-history.en-us.md) exposes
revision-bound bounded pages and a reusable native list. The legacy RPC list remains
an unpaged array; the remaining domain contracts are still under development.
