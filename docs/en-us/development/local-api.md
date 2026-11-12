# Local API and CLI

The local automation API is an **experimental candidate for 1.0**. Its protocol
version is independent of the desktop version and plugin RPC version. A protocol
number alone is not a stability promise. The machine-readable source is
`src-tauri/src/automation/schema/v1.json`, composed with domain-owned preference
schemas by `automation/domains/preferences/schema.rs`.
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
stdin. Read methods require an empty object. To update preferences, first obtain
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

## Ownership and compatibility

`automation/contract.rs` owns envelopes and errors, `schema/` owns discovery,
`domains/` owns independent public projections, `transport/` owns authentication,
discovery and framing, `client/` owns bounded client communication, and `cli.rs`
owns arguments, output and exit codes. Business
logic remains in the shared application services. UI state and native database
structures are not public API contracts.

Before this surface is marked stable: freeze input/output/error fixtures, validate
real outputs against schemas, test an older console client against the new host,
verify packaged binaries on supported platforms, and document deprecation rules.
New write methods must use existing validation, authorization, revisions and
invalidation rather than introducing another persistence path.
