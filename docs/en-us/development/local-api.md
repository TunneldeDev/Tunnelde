# Local API and CLI

The local automation API is an **experimental candidate for 1.0**. Its protocol
version is independent of the desktop version and plugin RPC version. A protocol
number alone is not a stability promise. The machine-readable source is
`src-tauri/src/automation/schema/v1.json`.

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
tunnelde-cli call api.describe
```

Help, CLI version and the CLI's own schema work offline. Live calls use the
running application's domain services. They do not read its database separately,
start a webview, execute a shell, or forward arbitrary Tauri invocations. The
initial live methods are read-only. Saved-host results exclude notes, key paths
and credentials. They include addresses and usernames; treat output as private.
Plugin-defined host sources are not part of the saved-host list.

Successful live calls write one JSON object to stdout, with `version`, `id` and
`result`. Errors write `version`, `id` and `error: {code, message}` to stderr.
Exit codes are 0 (success), 1 (operation failure), 2 (input/protocol error),
3 (unavailable/timeout) and 4 (authentication failure). Messages are explanatory;
programs must use codes. Offline version and discovery return plain JSON objects.
`call METHOD --params JSON` accepts an object; use `--params -` to read it from
stdin. The initial methods require an empty object.

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
discovery and framing, and `cli.rs` owns arguments, output and exit codes. Business
logic remains in the shared application services. UI state and native database
structures are not public API contracts.

Before this surface is marked stable: freeze input/output/error fixtures, validate
real outputs against schemas, test an older console client against the new host,
verify packaged binaries on supported platforms, and document deprecation rules.
New write methods must use existing validation, authorization, revisions and
invalidation rather than introducing another persistence path.
