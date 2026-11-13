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
eight concurrent connections, a 10-second server deadline, 32 KiB request limit
and 4 MiB response limit. Excess connections close without a response; the CLI
reports unavailable. Unknown methods and extra parameters fail explicitly.
The CLI allows up to three seconds to connect, then ten seconds in total for
request/response I/O. Partial output does not reset that deadline; each write is
also limited to three seconds. A timeout after sending a write does not prove
that the host rejected or rolled it back. Re-read its snapshot before retrying.
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
