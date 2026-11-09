# Local logging and diagnostics

Tunnelde writes application diagnostics to the configured Logs storage directory. Files rotate daily
as `YYYY-MM-DD.tunnelde.jsonl.log`. The output panel reads these files and displays readable,
colored entries; JSON Lines remains the on-disk format for tooling. Use the status bar's Output
entry or the command palette to open the dockable bottom panel. Its actions open the original file
or its directory. Clearing the displayed output does not delete the local files.

The diagnostic log and operation history serve different purposes. Diagnostics record severity,
domain and technical context. Operation history records bounded actions and opaque object IDs.
Do not use either for passwords, keys, authorization headers, document contents or terminal input.

The `log.file` build-worker source path identifies the dependency used to build the application. It does
not refer to a directory required on the user's computer. Keep these source locations as useful
diagnostic metadata; open the local application log to investigate the actual failure.

## Built-in features

Native modules can use `crate::diagnostics::write(LogOrigin::Native, LogEntry { ... })`. Existing
`tracing` events continue to use the same local writer. Frontend modules import
`writeLog(domain, entry)` or the best-effort `reportError(domain, operation, error)` from
`src/lib/diagnostics.ts`. The native `logs_write` command prefixes frontend domains with `frontend.`.
The event buses use this path so subscriber failures reach local logs instead of only DevTools.

```ts
await writeLog("files", {
  level: "warn",
  message: "Listing did not complete",
  operation: "list",
  requestId: "request-123",
  fields: { attempt: 2, status: 403 },
});
```

## Plugin API

An approved running plugin with the `log` permission may call the existing `log` host method.
The SDK retains `host.log(message, level)` and adds an options overload:

```js
await host.log("Connection failed", {
  level: "error",
  domain: "connection",
  operation: "connect",
  requestId: "request-123",
  fields: { status: 403, attempt: 2 },
});
```

The `log` method has a [frozen v1 contract](../tests/fixtures/plugin-compat/logging-v1.json),
available through `host.describe()`. Message/level calls have existed since 0.21.0;
structured options and requested-severity handling require 0.33.0-beta.5 or later. Older hosts
may ignore added options. Discover the contract before depending on these semantics, or set
an appropriate `engines.tunnelde` range. The `since` metadata records method availability,
not the introduction of every option or the stability commitment.
Levels are `trace`, `debug`, `info` (default), `warn`, `error`; uppercase equivalents and `warning`
are accepted. Invalid levels are rejected. Requested severity is the event's actual severity,
including native filtering. WASM's existing numeric log ABI is unchanged.

The host supplies the plugin ID and runtime generation. The resulting domain is
`plugins.<plugin-id>.<domain>` (default suffix `application`), so payload fields cannot impersonate
another plugin. Approval, permission and runtime revocation checks remain in force. Plugins cannot
select log file paths or read arbitrary application logs through this API.

Message text is limited to 16 KiB in UTF-8. `domain`, `operation` and `requestId` are optional,
nonempty ASCII identifiers of at most 128 bytes using letters, digits, `.`, `_`, `-`, `:`.
`fields` is a JSON object of at most 16 KiB before redaction, at most 256 visited nodes and four
levels below its root (the root counts as one visited node). Keys use the same identifier
alphabet with a 64-byte limit, including nested object keys. `domain`, `operation` and
`requestId` also accept `null` as absent; `message`, `level` and `fields` do not accept `null`.
Unknown top-level properties are ignored. The schema checks structure and character counts;
UTF-8 byte quotas, nested keys, depth and visited nodes are additional runtime checks.
Control characters are replaced with spaces. Credential-like keys are recursively redacted;
structured HTTP/SOCKS URL strings lose user information, query strings and fragments. Arbitrary
free text and URL path components cannot be reliably scrubbed: callers must not include secrets.
Context keys stay nested and cannot override the host's severity, identity or routing fields.

Output filters support `domain:`, `plugin:`, `level:` and `source:` with funnel presets. Operation
and request IDs remain searchable in the message. A write returning `null` means the host accepted
the event. The configured `TUNNELDE_LOG` filter still applies (default `info,tunnelde_lib=debug`),
and the bounded nonblocking writer may drop lines under overload. This is diagnostic logging,
not a durable audit transaction or a promise that every accepted event has reached disk.
The method does not subscribe the caller to events or expose the local JSONL record layout as
a stable protocol. Malformed entries report `plugin.api.invalid:log`; byte, identifier or
context limits report `logs.invalid:<field>`. These use JSON-RPC `-32000`, while common
parameter-object/total-request validation uses `-32602` and authorization uses `-32001`.
Handle unknown errors as well as the contract's `knownErrors` list.
