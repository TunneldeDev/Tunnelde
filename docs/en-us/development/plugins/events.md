# Plugin events

[简体中文](../../../zh-cn/development/plugins/events.md) · [API compatibility](api.md)

`events.publish` sends plugin data notifications to the application frontend under a
frozen v1 contract. It requires no additional domain permission, but the caller must
be an approved, running executable plugin. Restricted mode, revoked approval and a
retired runtime generation still prevent calls. Events grant no file, command or
other API permissions.

```js
await host.call("events.publish", {
  event: "progress",
  payload: { operationId: "export-1", completed: 3, total: 10 },
});
```

Names contain 1–128 ASCII letters, digits, `.`, `_`, `:` or `-`. `payload` accepts any
JSON value and defaults to `null` when omitted, preserving existing calls. Additional
parameters are ignored. The complete serialized parameter object is limited to
256 KiB of UTF-8, including the name and JSON overhead.

The host emits this envelope on `plugin://event`:

```json
{
  "pluginId": "example-plugin",
  "generation": 7,
  "event": "progress",
  "payload": { "completed": 3 }
}
```

The approved host runtime supplies `pluginId` and `generation`; request fields cannot
replace them. Background process tasks use the same envelope, but their `task`
payload remains experimental. A stable envelope does not freeze every plugin's
payload, chat protocol or task API. Consumers must ignore unfamiliar added fields.

A `null` result means the event transport accepted the publication, not that a
subscriber processed, saved or displayed it. Publishing can succeed with no
subscribers. Events offer no persistence, replay, cross-request completion order or
exactly-once guarantee. Recoverable operations need their own retained state and
snapshot/query API rather than relying exclusively on notifications.

Consumers must check plugin identity and the current runtime generation before
applying an update. Old events already queued in the frontend may arrive after a
stop, restart or revocation and must be ignored. Chat and similar consumers also
check session, run ID and sequence. The shared frontend event bus uses one transport
listener per event, releases it when the final subscription ends, retains no payloads,
supports AbortSignal and isolates individual handler failures.

Invalid names return `plugin.api.invalidEvent`. Missing or mistyped names return
`plugin.api.missing:event` or `plugin.api.invalid:event`; non-object or oversized
parameters return `plugin.api.invalidParams`. Transport failure returns an error and
must not be treated as success. Errors use the existing [API format](api.md).
Never publish passwords, tokens or private keys.

`api.describe` supplies `inputSchema`, `resultSchema`, `errorSchema` and `eventSchema`.
CI validates real host-generated events and results, then replays requests/responses
through a frozen historical SDK. The API protocol remains version 1; this contract
does not change the stability of other experimental methods.

## Inter-plugin bus

With `bus.communicate`, a runtime can advertise a versioned capability (`bus.advertise`) and find online providers (`bus.discover`). Subscribe to the public `bus.discovery` topic before querying so you don't miss changes. Use public topics for discovery, not secrets.

For private traffic, call `bus.create` and `bus.invite({busId,pluginId})`. The recipient must already be registered on the bus; only that runtime can `bus.join({invitationId})` or `bus.decline({invitationId})` before the 60-second expiry. Invitation messages are notifications, not proof that an invitation is still pending; `bus.invitations` lists current offers. Leaving discards private subscriptions and queued traffic; stopping the owner closes the channel. Membership never grants other host permissions.

`bus.snapshot({})` returns `{publicTopics,channels:[{busId,ownerPluginId,members,topics}]}`. Only joined private channels are visible; `members` lists plugin IDs and `topics` lists **your** subscriptions, not those of other members. Subscribe to `bus.membersChanged` **on the private bus** before reading the snapshot. A join, departure or member shutdown invalidates that snapshot; a closed channel instead sends `bus.closed` directly to its members. There is no need to poll the public bus for membership.

Use one `bus.receive` reader per runtime (up to 32 messages per batch). If `lost > 0`, refresh `bus.snapshot`, `bus.invitations`, and any relevant domain state; snapshots don't replay application messages. Queues hold 128 messages; payloads are limited to 16 KiB. Feature-detect new methods in `api.describe().methods` before using them with older hosts.
