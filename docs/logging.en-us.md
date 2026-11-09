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

The extended options are experimental. Check `host.describe()` for the running host's parameters
before depending on them; older hosts accept message and level but may ignore added options.
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
container levels below its root. Keys use the same identifier alphabet with a 64-byte limit.
Control characters are replaced with spaces. Credential-like keys are recursively redacted;
structured HTTP/SOCKS URL strings lose user information, query strings and fragments. Arbitrary
free text and URL path components cannot be reliably scrubbed: callers must not include secrets.
Context keys stay nested and cannot override the host's severity, identity or routing fields.

Output filters support `domain:`, `plugin:`, `level:` and `source:` with funnel presets. Operation
and request IDs remain searchable in the message. A write returning `null` means the host accepted
the event. The configured `TUNNELDE_LOG` filter still applies (default `info,tunnelde_lib=debug`),
and the bounded nonblocking writer may drop lines under overload. This is diagnostic logging,
not a durable audit transaction or a promise that every accepted event has reached disk.
