# Cancelling plugin calls

Cancellation is an experimental transport capability. It keeps the existing API
version and method permissions; it does not enlarge the stable API set.

The stdio SDK sends a JSON-RPC `$/cancelRequest` notification with `params.id`
when an outstanding call is aborted or reaches its local deadline. Explicit SDK
close also sends cancellation for its outstanding calls while the pipe is usable. The identifier
belongs to that connection's plugin-to-host direction. Notifications have no
top-level `id` and no response. New hosts stop awaiting that request and return
`plugin.api.cancelled` (`-32800`) to its original identifier. Unknown or completed
identifiers have no effect. Older hosts ignore the notification: only the local
promise is cancelled on those hosts.

Trusted frontend plugins can use a signal and a deadline:

```ts
const owner = new AbortController();
const answer = context.api.call<boolean>(
  "ui.confirm", { message: "Continue?" },
  { signal: owner.signal, timeoutMs: 60_000 },
);
owner.abort();
```

The frontend transport reserves a token-owned ticket before dispatch. An abort
that arrives before dispatch invalidates the ticket, so it cannot be missed.
Replacing or closing the frontend token also cancels its requests. A reservation
that arrives after local cancellation is released without dispatching work.
Already aborted calls allocate nothing. Ticket identifiers are internal and are
not plugin capabilities for other owners.

Each transport registry allows at most 64 pending tickets and 32 per owner. Tickets
expire after 120 seconds, including reservation time; frontend calls default to a
60-second local deadline. Abandoned unclaimed tickets are pruned before admitting
new work. Stdio control notifications bypass the normal request quota.

Cancellation drops asynchronous waiting and dismisses that request's pending
native confirmation. It is **not rollback**: a completed write, an external
command, or blocking work already started may still have effects. An aborted call
does not establish whether a mutation committed. Do not automatically repeat a
mutation after losing its reply. Read the operation's revision or durable status
and follow its domain-specific recovery contract. Mutating domains need their own
commit fence, resource budget, idempotency and compensation rules; the transport
alone cannot provide them.
