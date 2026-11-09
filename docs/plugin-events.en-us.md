# Plugin events

[简体中文](plugin-events.zh-cn.md) · [API compatibility](plugin-api.en-us.md)

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
must not be treated as success. Errors use the existing [API format](plugin-api.en-us.md).
Never publish passwords, tokens or private keys.

`api.describe` supplies `inputSchema`, `resultSchema`, `errorSchema` and `eventSchema`.
CI validates real host-generated events and results, then replays requests/responses
through a frozen historical SDK. The API protocol remains version 1; this contract
does not change the stability of other experimental methods.
