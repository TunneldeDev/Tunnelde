# Local API and CLI

See the [compatibility policy](local-api-compatibility.md) for the finite stable
scope, data lifetimes and evolution rules.

The local automation protocol v1 and its seven declared methods are **stable**.
Other application and plugin APIs keep their own stability status. The protocol
version is independent of the desktop version and plugin RPC version. A protocol
number alone is not a stability promise. Each method declares `stability` and
`since`; the seven stable methods record their introduction in 0.38.0-beta.1,
not their stable declaration. An experimental method may have `since: null`
when no release introduction is declared; discover availability on the running
host instead of inferring it from the application version. The source is
`src-tauri/src/automation/schema/v1.json`, composed with domain-owned preference
schemas and the domain adapters below `automation/domains/`.
Common request/response schemas, error codes and CLI exit codes are published in
the `protocol` section of discovery, sourced from `schema/protocol-v1.json`.
Schemas use `x-maxBytes` for UTF-8 byte limits in addition to JSON Schema's
Unicode character limits. Consumers validating schemas must implement this
keyword; the host always enforces it. The repository checker supports it.

Build the console executable with:

```sh
cargo build --locked --manifest-path src-tauri/Cargo.toml --bin tunnelde-cli
```

The installed desktop executable accepts the same commands with a `cli` prefix,
before any GUI or single-instance initialization:

```sh
tunnelde cli app info
tunnelde cli hosts list
tunnelde cli sessions list
```

On Windows, use `Tunnelde.exe cli ...`; callers using subprocess pipes receive
normal stdout/stderr. For interactive Windows shells the standalone console
executable also gives the shell a console process to wait for. On macOS the
desktop binary is inside `Tunnelde.app/Contents/MacOS/`; Linux uses the installed
executable or AppImage followed by `cli`.

Run the desktop application, then call the optional console executable:

```sh
tunnelde-cli --help
tunnelde-cli --version
tunnelde-cli api describe
tunnelde-cli app info
tunnelde-cli hosts list
tunnelde-cli sessions list
tunnelde-cli preferences schema
tunnelde-cli preferences snapshot
tunnelde-cli call api.describe
```

Help, CLI version and the CLI's own schema work offline. Live calls use the
running application's domain services. They do not read its database separately,
start a webview, execute a shell, or forward arbitrary Tauri invocations. The
Core discovery, hosts and sessions are read-only. Public preferences also support
revision-checked updates through the shared settings writer. Saved-host results exclude notes, key paths
and credentials. They include addresses and usernames; treat output as private.
Plugin-defined host sources are not part of the saved-host list.

Successful live calls write one JSON object to stdout, with `version`, `id` and
`result`. Errors write `version`, `id` and `error: {code, message}` to stderr.
Exit codes are 0 (success), 1 (operation failure), 2 (input/protocol error),
3 (unavailable/timeout), 4 (authentication failure) and 5 (stale revision). Messages are explanatory;
programs must use codes. Offline version and discovery return plain JSON objects.
Host errors preserve the request ID. Failures before a valid host response use
an empty ID. Unknown error codes use exit 1; malformed or mismatched responses
use `invalid_response` and exit 2.
`call METHOD --params JSON` accepts an object; use `--params -` to read it from
stdin. Stable read methods require an empty object; experimental
domain methods declare their own parameters. To update preferences, first obtain
the revision from `preferences snapshot`, review the desired changes, and submit:

```sh
tunnelde-cli preferences update --params '{"revision":"REVISION_FROM_SNAPSHOT","changes":{"appearance":{"theme":"dark"},"editor":{"tabSize":4}}}'
```

Use `--params -` with stdin in environments where shell JSON quoting is awkward.
Only supplied public fields change; collections replace their previous contents.
Unknown fields and invalid values return `invalid_preferences` (exit 2). A stale
revision returns `stale_revision` (exit 5). Read a new snapshot and review the
changes rather than automatically retrying with the new token. Validation and
failed commits do not publish settings. Persistence and normal desktop effects
complete together without an intervening asynchronous cancellation point;
disconnecting the CLI does not roll back a committed update. Revision tokens are
opaque, nonempty, at most 128 UTF-8 bytes and contain no control characters.
The request limit remains 32 KiB even though the plugin adapter has a larger
budget. Proxy passwords, credentials, internal metadata and provider selection
are outside the public preference schema. Values may contain user CSS, proxy
addresses and usernames, so keep snapshots private. This API does not request an
application restart; changes with deferred effects follow ordinary desktop
settings behavior. Storage relocation remains a separate domain and is not
available through preferences.update.

## Forwarding status (experimental)

`forwards.list` reads the same saved rules and runtime registry as the native
forwarding manager, without opening a terminal or creating another SSH session.
Its independent DTO and schema live in `automation/domains/forwarding/`.

```sh
tunnelde-cli forwards list
tunnelde cli forwards list --params '{"limit":20}'
tunnelde-cli forwards list --params '{"after":"LAST_RETURNED_ID","limit":20}'
```

Results contain `entries` and nullable `nextAfter`. Each entry has `id`, `hostId`,
`name`, opaque persisted `revision`, `direction` (`local`/`remote`), `bind` and
`target` endpoints (`host`/`port`), and `state` (`running`/`stopped`). Running means
the host has registered the listener; it does not prove the destination service
is reachable. A disconnect retires its listeners through the normal SSH lifecycle.
Runtime identities, session IDs and credentials are excluded. Addresses and rule
names are private information. This read-only method does not install helpers,
request credentials or start/stop/change a rule.

`limit` is 1–128 (default 50); pages are at most 64 KiB. Continue using `nextAfter`
as `after` until it is null. IDs use ascending binary ordering. Continuation works
even if its rule was deleted. Each page is a live read, not a frozen snapshot:
edits, deletion and newly inserted earlier IDs can change enumeration; restart
without `after` to rescan. The token is only a position, never authorization.
An empty `after` starts at the beginning; other IDs are at most 128 UTF-8 bytes
without control characters. SQL bounds the selected rows and stored blobs;
corrupt records cause an explicit failure rather than silently omitting a rule.
Four concurrent blocking readers have a budget separate from log readers.
Cancellation stops subsequent reads, while a worker retains capacity until it
actually exits. Invalid parameters return `invalid_request` (exit 2); unavailable
or malformed storage and exhausted readers return `operation_rejected` (exit 1).
The seven stable methods and existing plugin forwarding contracts are unchanged.

## Confirmed forwarding changes (experimental)

`forwards.save`, `forwards.remove` and `forwards.stop` request a native confirmation
on the running desktop. The prompt identifies this as a request from a local
program, shows the complete proposed/current rule and warns about non-loopback
bind addresses. Possessing the local capability does not identify a particular
calling program. Only one local forwarding confirmation can remain open; another
request fails rather than replacing it. Consent expires after 120 seconds.

```sh
tunnelde-cli forwards save --params '{"id":"dfe523d7-6893-4387-a609-b9f4ed1e0b23","hostId":"SAVED_HOST_ID","name":"Database","revision":null,"direction":"local","bind":{"host":"127.0.0.1","port":15432},"target":{"host":"127.0.0.1","port":5432}}'
tunnelde-cli forwards stop --params '{"id":"RULE_ID","revision":"OBSERVED_REVISION"}'
tunnelde-cli forwards remove --params '{"id":"RULE_ID","revision":"OBSERVED_REVISION"}'
```

For creation, generate a fresh canonical lowercase UUID and explicitly send
`revision: null`. Creation atomically requires the ID to be absent; repeating
the request cannot overwrite an existing rule. To edit, send the observed ID and
revision from `forwards.list`, with all desired rule fields. Saving does not
start a connection. An existing rule must be stopped before editing or removal;
the final commit checks this and the exact revision again after consent.

Stop captures the running instance before consent and checks it again with the
persisted revision at commit. If someone stops and restarts the rule while the
dialog is open, the old approval cannot stop the replacement. Network cleanup
keeps its own task after the stop commits, even if the caller disappears.

Results have `outcome` (`saved`, `removed`, `stopped`, or `dismissed`), `id`, and
`revision`. Save returns the newly committed revision. Other outcomes echo the
reviewed revision; a dismissed creation has a null revision. A stale rule or
running instance returns `stale_revision` (exit 5). An active edit/removal, absent
running instance, busy/expired dialog, or cleanup failure returns
`operation_rejected` (exit 1). Errors do not imply that no side effect occurred.
After a lost reply or timeout, read current state before deciding what to do;
never automatically retry with a new ID or revision. A late dialog response
cannot write after the awaiting operation expires. Closing a CLI connection
alone does not revoke a still-pending desktop confirmation.

These methods accept no credentials, SSH session IDs, runtime IDs, or trust
override. Connection startup uses the separate request flow below, retaining
normal host-key and credential interaction. The installed CLI can use
`call forwards.save` and the other generic forms too. These three methods remain
experimental; they do not expand the seven-method stable promise.

## Forwarding startup receipts (experimental)

`forwards.start` accepts `{id, revision, requestId}` and returns immediately with
a receipt. Generate a new canonical lowercase UUID for `requestId` and use the
saved rule revision from `forwards.list`. A successful CLI exit means the request
was accepted; only phase `running` confirms listener admission.

```sh
tunnelde-cli forwards start --params '{"id":"RULE_ID","revision":"OBSERVED_REVISION","requestId":"ddc61387-4c72-4cc2-8a1a-5b153769e81b"}'
tunnelde-cli forwards start-status --params '{"requestId":"ddc61387-4c72-4cc2-8a1a-5b153769e81b"}'
tunnelde-cli forwards cancel-start --params '{"requestId":"ddc61387-4c72-4cc2-8a1a-5b153769e81b"}'
```

The main application first shows a plain native confirmation containing the
captured host, jump route, direction, endpoints and exposure warning. After
confirmation it opens the normal host-key/password dialog. Credentials, session
IDs and trust overrides are never public parameters. Changing a connection
destination invalidates the review; the dialog cannot silently retarget a retry.
Connections are main-application owned, independent of plugin/user-terminal
sessions. Rules with the same reviewed host/route can share this connection;
stopping its last rule disposes it after any pending start releases its reference.

Phases are `consent`, `credentials`, `connecting`, `preparing`, then terminal
`running`, `dismissed`, `cancelled`, `expired` or `failed`. Receipts include the
original input, `expiresAt` (the pending-request deadline in Unix milliseconds,
not the receipt-retention deadline), and a fixed diagnostic `error` key or null.
`running` is a historical admission result; use `forwards.list` for
current connection health. `cancelStart` revokes only pending work and never
stops an already admitted instance; use the separately confirmed `forwards.stop`.
An explicitly approved host-key record committed before cancellation is retained.

There is one pending interaction, a 300-second total request limit, a 120-second
native-consent limit and a 15-second main-window heartbeat. Closing the dialog,
document reload/loss, expiry or cancellation fences late trust/admission and
cleans unpublished resources. Terminal receipts remain in memory for 15 minutes
after completion; maximum 128 receipts, rejecting new requests rather than
evicting unexpired receipts. Identical UUID/input retries replay the same receipt;
different input with the same retained UUID is rejected. Receipts do not survive
application restart. An unknown receipt is uncertain: inspect `forwards.list`
before deciding whether to submit with a **new** UUID. Never reuse an unknown UUID.
Native events and a pending-request query both deliver the credential prompt.
These three methods are experimental and keep the ordinary 10-second local API
exchange budget; they do not expand the stable API baseline.

## Structured log reading (experimental)

`logs.read` reuses the persisted diagnostic/operation service used by plugins.
Its machine schema belongs to `src-tauri/src/logs/read/schema.json`; the local
adapter composes it into discovery. It does not change the seven-method stable
baseline or the separate plugin permission model.

```sh
tunnelde-cli logs read
tunnelde cli logs read --params '{"filter":{"domains":["network"],"levels":["warn","error"]},"limit":50}'
tunnelde-cli logs read --params '{"source":"operations","limit":20}'
```

The result is a structured page with `entries`, `cursor`, `hasMore`, `reset` and
`gap`. Entries contain timestamp, level, domain, optional plugin ID, message,
sanitized fields and a truncation flag, without JSONL text or caller-selected
paths. `filter` supports exact domain/plugin/level lists and case-insensitive
text. Filters are ANDed across fields and ORed within a list. Text is at most
256 UTF-8 bytes; `limit` is 1–200 (default 100), and a page is at most 128 KiB.

Send the returned cursor with the same source and filter to continue; the limit
may change. `hasMore` means another bounded read is available, not a subscription.
When false, retain the cursor and poll later for appended complete records.
Cursors bind the local reader, application process, source and normalized filter;
plugin cursors cannot be reused. Invalid or mismatched cursors return
`invalid_request` (exit 2); omit the cursor to begin a new read after a restart.

Diagnostics begin within the most recent 256 KiB of the current log. Operations
cover at most the latest 1000 retained records. Rotation/truncation, discarded
malformed records or retention gaps are reported through `reset`/`gap`; partial
tails wait for an append. This is bounded diagnostics, not a reliable audit or
all-history export. Four concurrent local blocking readers are allowed; a timed
out caller stops subsequent scanning, while its worker keeps a slot until it
actually exits. Busy readers and unavailable storage return `operation_rejected`
(exit 1), without leaking internal paths or exception details.

The same-account local capability grants access to application and plugin logs.
Structured fields are sanitized by the shared service, but free text, host data
and plugin messages may still contain private information. Treat output and
saved pages as private. The method does not enable plugins, acquire their grants,
change logging configuration or execute commands.

The desktop binds an ephemeral IPv4 loopback port and publishes `automation.json`
in its standard application data directory. This pointer contains a path only.
The random capability and address live inside a separate directory created with
Unix mode 0700 or a protected current-user Windows DACL. The capability is
replaced on each launch and is never logged. Same-account programs that can read
that directory may call this API. It is not a sandbox against other programs
already running as the same user.

Use `--endpoint /absolute/path/to/automation.json` or `TUNNELDE_ENDPOINT` for an
isolated application identifier, `TUNNELDE_DATA_DIR`, or a nonstandard environment. The default path
uses `dev.tunnelde.app` below APPDATA on Windows, `~/Library/Application Support`
on macOS, and XDG_DATA_HOME (or `~/.local/share`) on Linux. There is no remote
listen address or network authentication mode. Loopback addresses are checked
on both sides. Do not publish or copy capability files to another machine.

The wire protocol allows one newline-terminated JSON request per TCP connection.
Requests contain `version`, `id`, `token`, `method` and `params`. There are at most
eight concurrent connections, a default 10-second server deadline, 32 KiB request limit
and 4 MiB response limit. Excess connections close without a response; the CLI
reports unavailable. Unknown methods and extra parameters fail explicitly.
The CLI allows up to three seconds to connect, then ten seconds in total for
request/response I/O. Partial output does not reset that deadline; each write is
also limited to three seconds. A timeout after sending a write does not prove
that the host rejected or rolled it back. Re-read its snapshot before retrying.
Only the exact `forwards.save/remove/stop` methods extend authenticated execution
to 135 seconds and the CLI exchange to 150 seconds. Their framing and
authentication must still finish within ten seconds. Other methods, unknown
method names and unauthenticated connections receive no extension.
Request envelopes reject unknown fields. Response envelopes, error objects and
endpoint descriptors accept additional metadata while retaining required field
types, version/request correlation and exactly one of `result` or `error`.
Additional metadata is ignored by the CLI; method results are preserved.
This does not permit removing or changing existing fields. Published method
schemas still define the current producer's allowed fields. Endpoint descriptors
also undergo runtime loopback, port and capability validation.
Endpoint availability is independent of webview visibility. A local API startup
failure is logged without preventing desktop startup.

Normal service shutdown removes its endpoint files. A forced process termination
may leave an inert private directory. Its old capability cannot authenticate a
new process. Public installer and upgrade acceptance remain release gates.
The desktop CLI entry is part of the existing desktop binary; a standalone
`tunnelde-cli` is an optional source build until it has its own distribution policy.

See [installer acceptance](installer-acceptance.md) for the reproducible public
Windows installer data-retention check and its limits. In-app OTA and other
platforms require separate acceptance evidence.

## Ownership and compatibility

`automation/contract.rs` owns envelopes and errors, `schema/` owns discovery,
`domains/` owns independent public projections, `transport/` owns authentication,
discovery and framing, `client/` owns bounded client communication, and `cli.rs`
owns arguments, output and exit codes. Business
logic remains in the shared application services. UI state and native database
structures are not public API contracts.

The stable baseline is `tests/fixtures/local-api/stable-v1/declaration.json`, with
a separate discovery schema and digests of the unchanged historical fixtures.
CI checks actual producer outputs against this baseline. Historical CLI behavior,
packaged binaries and installation/upgrade retention remain release checks;
schema equality alone is insufficient.
New write methods must use existing validation, authorization, revisions and
invalidation rather than introducing another persistence path.
