# Plugins

## Quick access and command results

Press F1 and type `> UUID` (or another plugin name/command) to open a contributed
view or execute an installed plugin command. Listing commands reads manifest metadata
and does not start Node. Execution retains runtime consent and plugin approval.
Commands without views open a host-owned result page with scrollable, resizable,
plain-text output, Copy, Clear, and command buttons. Settings → Keyboard Shortcuts
includes installed plugin commands and views; these bindings are included in profiles.

The workspace API also provides `workspace.showQuickAccess`,
`workspace.setPaneLocked`, and `workspace.resizeSplit`, gated by `workspace.write`.
Quick Access accepts an initial query but never automatically executes it.

AI views group intermediate messages, native thinking summaries, and tool activity
per user turn in collapsible sections. Final answers and approval prompts stay visible.
Activity output is bounded and displayed as text/Markdown without arbitrary HTML.
See the [official extension investigation](reviews/2026-11-02-vscode-agent-extensions.md)
for the source and licensing findings; arbitrary VSIX packages are not supported.

The independent marketplace and official source packages live in
[TunneldeDev/tunnelde-hub](https://github.com/TunneldeDev/tunnelde-hub). For installing and
connecting Codex, Claude Code, Pi or Tunnelde AI, start with [the assistant guide](ai-assistants.md).
Those are four separately installed integrations; Tunnelde AI does not aggregate coding CLIs.

Executable plugins speak JSON-RPC 2.0 over stdio in separate processes. Pure theme packs contain only a manifest and theme colors; they do not start a process or require Node.

## SSHFS and data-only plugins (0.27.0+)

Install **SSHFS** or **SSHFS Lite** from the independent marketplace. Both use the
same native mount panel; Lite needs no Node runtime. Connect a saved SSH host first,
then choose its session, browse the remote directory, and choose an empty local
directory or unused Windows drive. Read-only access is the default. Mounts are
manual and reuse the SSH session's credentials, host-key trust, proxy and jump hosts.

System FUSE and a compatible SSHFS build are required. The panel checks both the
driver and passive/stdin transport support, offers installation guidance, and never
installs system components automatically. Close files before unmounting. Busy mounts
can be retried or explicitly force-unmounted. Revoking a plugin or disconnecting its
session immediately severs its authenticated transport, even if OS cleanup fails.
Cleanup failures stay visible for a retry. Mounted filesystems and OS permissions
still require platform testing with the installed driver distribution.

The `mounts.read` permission covers dependency detection and owned mount listings;
`mounts.write` covers mounting and unmounting. Plugins cannot unmount one another's
resources or read SSH passwords/keys. Node plugins use `mounts.dependencies`,
`mounts.list`, `mounts.mount` and `mounts.unmount` through the host API.

Data-only plugins set `runtime: "declarative"` and point `main` to local JSON:

```json
{ "views": { "main": { "title": "SSHFS Lite", "blocks": [{ "type": "mounts" }] } } }
```

Declare `main` in the manifest's `views`. These packages have no executable commands
and never evaluate JavaScript or resolve Node. The host still asks for declared
permissions and checks the package fingerprint. Views are available through F1 and
the command palette, like other plugin views.

Assistant chat blocks can expose `commands.target` and an `execution` object containing
`kind`, machine display metadata, `sessionId`/`hostId` for SSH, `cwd`, `home`, `platform`
and optional executable/runtime overrides. The host renders a machine selector independently
of provider models. Older blocks without this command retain the legacy profile selector.
The official plugins validate connected targets and persist their selection per conversation.

`files.sftp.resolveDirectory` (0.25.0+) accepts `{sessionId,path?}` and returns `{home,path}`.
It resolves account home, `~`, relative paths and the canonical working directory through
SFTP metadata without reading directory entries or running a shell. Like other direct SFTP
calls it requires the declared `sftp.read` permission and an approved executable plugin.

## Layout

```
hello/
  tunnelde-plugin.json
  index.js
```

`tunnelde-plugin.json`:

| Field         | Required          | Description                                                        |
| ------------- | ----------------- | ------------------------------------------------------------------ |
| `id`          | yes               | Lowercase letters, digits, `-` and `_`, up to 64 characters        |
| `name`        | yes               | Display name                                                       |
| `version`     | yes               | `major.minor` or `major.minor.patch`                               |
| `apiVersion`  | yes               | Must be `1`                                                        |
| `main`        | runtime dependent | Entry script inside the plugin folder; omit for pure theme packs   |
| `runtime`     | no                | `node` (default), `wasm`, data-only `theme` or `declarative`       |
| `description` | no                | One line shown in the list                                         |
| `commands`    | no                | `[{ "id": "greet", "title": "Say hello" }]`                        |
| `views`       | no                | `[{ "id": "status", "title": "Status" }]`                          |
| `permissions` | no                | Declared host API permissions; executable plugins require approval |
| `themes`      | no                | One or more named palettes; required for `runtime: "theme"`        |

The host runs Node plugins in a separate process. **Node is not bundled.** Before using an
existing system Node, Tunnelde asks for permission. Alternatively choose an executable explicitly
or install a private runtime on demand. The process is killed when the plugin is stopped,
updated, uninstalled or the app quits.

Settings → Plugins shows the selected path and version, offers detection and manual selection,
and lets you revoke system-runtime permission. Detection checks PATH (including Windows user
PATH) or the default login/interactive shell on Unix; it never recursively searches the disk.
Without consent, discovery does not execute the system Node binary. `TUNNELDE_NODE` is consulted
only after system-runtime permission is granted.

A manually selected executable takes precedence, followed by an installed private runtime,
then an explicitly permitted system runtime. Private Node 24 LTS is downloaded from nodejs.org,
checked against official SHA-256 metadata, and installed under the application data
`runtimes/node/` directory. Installation is cancellable and does not modify PATH, rc files or
the system installation. Only the executable is installed; plugins must ship their dependencies.

Node plugins run with the user's local permissions; the manifest permissions list is **not an
OS sandbox**. Trust only known publishers. WASM plugins retain the restricted existing runtime.

## Theme packs

Any plugin can provide one or more themes through a `themes` array. Pure theme packs use
`"runtime": "theme"`, omit `main` and `engines`, and have no commands, views or permissions:

```json
{
  "id": "my-themes",
  "name": "My Themes",
  "version": "1.0.0",
  "apiVersion": 1,
  "runtime": "theme",
  "themes": [
    {
      "id": "midnight",
      "name": "Midnight",
      "appearance": "dark",
      "accent": "#7298ff",
      "colors": {
        "background": "#101522",
        "sidebar": "#171e2e",
        "terminalBackground": "#101522"
      }
    }
  ]
}
```

Each pack may supply up to 32 themes with unique IDs and nonempty names. `appearance` is
`light` or `dark`; `accent`, when supplied, is `#RRGGBB`. `colors` must contain at least one
recognized region from the settings color map, with `#RRGGBB` values. Unknown keys, CSS,
scripts and invalid colors are rejected. See `TunneldeDev/tunnelde-hub/plugins/studio-themes` for a pack containing
both dark and light themes without executable code.

Installed palettes appear in Settings → Appearance and in the plugin detail page. Applying
one changes the base appearance, accent and full color map in one settings save; omitted
regions follow the base appearance. Installing a theme pack does not change the current
appearance. Removing or updating a plugin preserves already applied color values until the
user selects another theme. Executable plugins can contribute palettes without being started.

## Protocol

One JSON object per line on stdin and stdout. stderr is logged and never parsed.

Host → plugin requests (the plugin answers with `result` or `error`):

| Method        | Params                     | Expected result                                                     |
| ------------- | -------------------------- | ------------------------------------------------------------------- |
| `initialize`  | `{ apiVersion, pluginId }` | Any value; `{ "ok": true }` is typical                              |
| `command.run` | `{ command, input? }`      | Any JSON value; interactive tools return `{ text, title?, error? }` |
| `view.render` | `{ view, locale? }`        | `{ title?, blocks: [...] }`                                         |
| `shutdown`    | `{}`                       | Any value, then exit                                                |

Plugin → host notifications use the same framing without an `id`:

```json
{ "jsonrpc": "2.0", "method": "log", "params": { "level": "info", "message": "ready" } }
```

Timeouts: 8 seconds for `initialize`, 20 seconds for `view.render`, and 120 seconds for
`command.run` and plugin-to-host requests. Individual services impose shorter limits.

## Host API and SDK

Executable Node plugins can send JSON-RPC requests back to the host while handling a
command. Replies use the same ID; both directions continue reading concurrently, so
an awaited host call does not block the command response. The independent hub supplies
a zero-dependency SDK in `sdk/tunnelde-plugin.mjs`, TypeScript declarations and the full
89-method catalogue in `sdk/api.md` and `sdk/api.json`.

```js
import { createPlugin } from "./tunnelde-plugin.mjs";

createPlugin({
  async run(command, input, host) {
    if (command !== "report") throw new Error("Unknown command");
    const snapshot = await host.call("hosts.snapshot");
    const layout = await host.call("workspace.snapshot");
    await host.call("storage.set", { key: "lastReport", value: Date.now() });
    return { text: JSON.stringify({ snapshot, layout }, null, 2) };
  },
});
```

Declare `hosts.read` and `workspace.read` for this example. `host.describe()` returns
`{version: 1, methods: [{name, permissions, params, description}]}` for the running
application. No domain permission is needed for API discovery, plugin-scoped storage
or plugin-identified notifications, but approval to execute the installed code is
still mandatory. Unknown methods and permissions are rejected.

| Permission                          | Available operations                                                                                                           |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `app.read`, `app.openExternal`      | App/platform metadata; validated HTTP(S) browser links                                                                         |
| `settings.read`, `settings.write`   | Read preferences; merge and validate preference patches                                                                        |
| `hosts.read`, `hosts.write`         | Saved-host/group metadata, create/update/delete, order and usage                                                               |
| `sessions.read`, `ssh.exec`         | Connected sessions; connect with normal host-key checks, disconnect, separate-channel command execution, terminal input/resize |
| `fs.read`, `fs.write`               | Local directory listing, UTF-8 text reads/writes, file/folder creation, rename, copy and deletion                              |
| `sftp.read`, `sftp.write`           | Corresponding remote file operations through existing SSH sessions                                                             |
| `monitor.read`, `monitor.write`     | Local/remote metrics, remote processes and validated TERM requests                                                             |
| `history.read`, `history.write`     | List, record, remove or clear a saved host's command history                                                                   |
| `workspace.read`, `workspace.write` | Live tabs/layout; open, activate, close, move, split and dock views                                                            |
| `clipboard.read`, `clipboard.write` | Explicit text clipboard access                                                                                                 |
| `log`                               | Bounded logs tagged with the plugin's identity                                                                                 |
| `network`                           | Declares network use by Node code; does not provide an OS network sandbox                                                      |
| `process.exec`                      | Explicitly selected local streaming executables; no automatic runtime discovery                                                |
| `secrets`                           | This plugin's own OS-keyring values; never SSH passwords or private keys                                                       |

Tunnelde 0.22 adds `events.publish`, plugin-owned `tasks.*`, scoped `tools.*`, and durable
`runners.*` transport. `tools.invoke` accepts `ask`, `approve`, `full` or `readOnly` and explicit
local roots, SSH sessions/hosts and remote roots. ReadOnly rejects commands and mutations.
Ask confirms changes and commands; Approve uses a trusted plugin's independent reviewer and
falls back to human approval; Full skips individual approval. Canonical path checks and content
hashes protect supported file tools. They do not sandbox arbitrary shell commands or trusted
Node plugins. Client revocation cancels pending requests and owned tasks/transfers.

Views may declare `location: "sidebar"`, `kind: "chat"` and an approved activity `icon` to
contribute a dockable controlled chat panel. `view.render` returns a `chat` block with session,
model and approval controls; subsequent `events.publish` messages carry sequenced chat updates.
The UI preserves drafts when a panel is moved. Secrets belong in `secrets.*`, never view data
or plugin storage. See the hub SDK and Tunnelde AI source for the complete schema.

Since 0.25.1, the controlled session picker provides searchable history with row-level
rename and delete actions. `commands.session` receives `action: "select" | "new" |
"rename" | "delete"`, a `sessionId` for an existing conversation, and `title` for a rename.
Rename/delete must operate on that ID without selecting a different conversation;
deleting the active conversation may select a remaining one. Empty or overlong names
must be rejected, and running conversations must reject deletion. Session entries can
include `untitled`, `updatedAt` (Unix milliseconds), `running` and `runId`. Use an empty
title plus `untitled: true` for a localized placeholder, and `untitled: false` for custom
names. Background terminal events matching the session's `runId` clear its running
indicator without changing the visible conversation. The four official assistants
implement this contract starting with 1.3.1.

Since 0.22.2, chat blocks may include a `title` and a `profilePolicy` containing
`primaryProtocols`, `reviewerProtocols` and `defaultProtocol`. The default must be one of
the primary protocols. The host uses these to show the plugin's identity and keep its
agent connections separate from approval-only API connections. Plugins must also enforce
their own fixed policy when loading, saving and executing configurations; view metadata
is not an authorization boundary. Codex, Claude Code and Pi are independent marketplace
packages with separate views, storage, permissions and runtimes. Tunnelde AI provides API
chat without aggregating these CLI agents.

Remote runners require explicit confirmation, a separately selected native helper, a fresh
private remote directory and an explicitly chosen remote runtime. No service or Node runtime
is installed. Closing the app preserves remote tasks; stopping a plugin or entering restricted
mode records stop requests and retries unreachable hosts on SSH reconnect. Runner records bind
to a saved host, so reconnecting with a new session ID can recover the same task. See
[native helper setup](../native-helpers/README.md).

The optional `tunnelde-agent` executable supports MCP stdio and remote runners. Ordinary SSH,
SFTP, terminal and local API chat use does not require it. Helper binaries and checksums are
provided as platform-specific artifacts of successful **Release** workflow runs in GitHub
**Actions**, with 30-day retention, or can be built from `native-helpers/`. They are not included
in desktop installers or the main GitHub Release downloads.

Host/session snapshots never return passwords or private keys. There is no generic
Tauri command invocation, vault access, host-key auto-trust, self-approval or API for
disabling restricted mode. Existing application validation and overwrite rules remain
in force. Closing a dirty editor asks the user and reports `pendingConfirmation`;
plugins cannot silently discard a draft. File, history, settings and host changes
refresh the corresponding UI. `ui.confirm` identifies its plugin and refuses to replace
an existing dialog. `terminal.write` accepts ordinary UTF-8 text, not base64.

Parameters must be objects no larger than 256 KiB; RPC frames and returned payloads
are capped near 1 MiB. Local text-file reads/writes are bounded to 512 KiB and reject
binary data. Remote text uses the normal 2 MiB editor limit and the stricter API
response/request limits still apply. Reads return `{content,size}`.
Plugin-scoped JSON storage is limited to 256 KiB total and is kept outside package
directories. Each Node process may have 32 host calls in flight; workspace requests
are additionally capped at 8 per plugin and 64 globally. SSH execution is bounded to
100–60000 ms and 1 MiB of combined output, and returns `{stdout,stderr,exitCode,signal}`.
Cancellation closes its dedicated channel; it cannot undo a command that already ran.

`files.upload` and `files.download` transfer binary files or whole directories using
`{sessionId,localPath,remotePath,overwrite?}` and return a transfer ID immediately.
They use the normal transfer progress UI and refresh destination listings on completion.
`files.cancelTransfer({transferId})` can cancel only work started by that plugin's current
runtime. Revocation, restricted mode, Stop or plugin process exit cancel its active
transfers; another plugin and a replacement process cannot cancel its work. Existing
overwrite, symlink and recursive-copy safeguards apply.

Poll `files.transferStatus({transferId})` to await completion before the next task.
It returns a transfer event with `running`, `done`, `failed` or `cancelled`, or `null`
for a missing/expired ID or a transfer outside the current plugin runtime. The host
retains only the latest 256 completed plugin transfers in memory and limits each
plugin to 8 concurrent background transfers.

The SDK defaults to a 30-second call timeout and supports `{signal, timeoutMs}` per
call, up to 120 seconds. Use a longer call timeout for a long SSH command or user
confirmation. Never retry a failed write automatically without checking its outcome.

## Approval and restricted mode

Installing a plugin leaves it stopped. On the first explicit Start, Open tool or Run,
Tunnelde displays the publisher/source and declared permissions, with choices to allow,
deny or enter restricted mode. Approval is tied to a SHA-256 fingerprint of the package
and its declared permissions. Updates, changed files and reinstallations require fresh
approval, including packages with the same ID and version. A package changed while its
approval dialog is open is rejected. System Node consent is a separate choice.

Settings → Plugins provides restricted mode and per-plugin grant revocation. Restricted
mode prevents executable Node and WASM plugins from starting, running commands or
rendering executable views; pure theme packs and marketplace management remain usable.
Entering it or revoking a grant invalidates runtime authorization before stopping the
process, interrupts pending host requests and closes that plugin's pending confirmation.
Every host request checks current authorization, and asynchronous replies are checked again.

Start the application with either argument to force restricted mode:

```text
tunnelde --safe-mode
tunnelde --restricted-mode
```

On Windows, use `tunnelde.exe --safe-mode`; on macOS,
`open -a Tunnelde --args --safe-mode`. Arguments sent to an existing single instance
also enter restricted mode. CLI-forced mode cannot be disabled during that process;
restart without the argument to make the settings switch available again. Restricted
mode is persisted, so removing the argument alone does not silently resume plugins.

After an abnormal exit following plugin execution, or corrupt plugin-security state,
startup enters restricted mode and offers recovery guidance. Runtime failures/timeouts
offer a one-time suggestion to enter restricted mode without repeatedly stacking dialogs.
Normal app exit clears the recovery marker. Grants are independent of appearance resets.

Node plugins execute with the user's OS privileges. Manifest permissions protect the
host API, **not direct Node filesystem, process or network access**. Restricted mode
stops application-managed executable plugins and blocks their host API; it cannot undo
previous writes or external processes started by arbitrary code. Use trusted publishers.

## WASM plugins

A plugin can run as a WebAssembly module instead of a Node process. Set `"runtime": "wasm"` in
`tunnelde-plugin.json` and point `main` at a `.wasm` file; when `runtime` is omitted it defaults to
`node`. The host compiles the module when the plugin directory is scanned and starts and stops it
without spawning a process.

The module must export:

| Export          | Signature                     | Description                     |
| --------------- | ----------------------------- | ------------------------------- |
| `memory`        | linear memory                 | At least 327680 bytes (5 pages) |
| `tunnelde_call` | `(i32, i32, i32, i32) -> i32` | Request handler                 |

For every call the host writes the request JSON at offset `1024` and invokes
`tunnelde_call(in_ptr, in_len, out_ptr, out_cap)` with `in_ptr = 1024`, `out_ptr = 65536` and
`out_cap = 262144` (256 KiB). The guest writes its response into that buffer and returns the number
of bytes written; the host reads that slice back and parses it as the JSON result.

Requests use the same payloads as the Node protocol, without JSON-RPC framing:

```json
{ "method": "run", "command": "greet" }
{ "method": "render", "view": "status" }
```

The host provides one import, `env.log(level: i32, ptr: i32, len: i32)`, which reads `len` bytes of
UTF-8 from the guest's memory at `ptr` and logs the text. `level >= 2` is logged as a warning and
anything lower as info, and messages are capped at 8 KiB. Every call instantiates the module in a
fresh store, so the guest starts with clean state each time.

The WASM ABI remains limited to that `env.log` import; the asynchronous Node host API is
not exposed through it. Each invocation is limited to 10 million fuel units, 64 MiB of
memory and one instance/two tables. Restricted mode and execution approval apply to WASM
as well. An infinite guest loop terminates when its fuel is exhausted.

## Views

`view.render` returns declarative blocks that the host renders read-only:

```json
{
  "title": "Status",
  "blocks": [
    { "type": "heading", "text": "Cluster" },
    { "type": "text", "text": "Three nodes" },
    { "type": "kv", "items": [{ "label": "Uptime", "value": "12d" }] },
    { "type": "table", "columns": ["Node", "Role"], "rows": [["db-1", "primary"]] }
  ]
}
```

Unknown block types are dropped, strings are capped at 4000 characters, tables at 12 columns and
200 rows. The host never evaluates HTML from a plugin.

Interactive views can add a `form` block with an ID, `fields` and `actions`. Fields support
`text`, `textarea` and `select` (with value/label options). Actions declare an ID, label and
manifest command ID. The host validates and renders controls, passes string field values plus
`_locale` in `input`, and provides an explicit copy-result button. Inputs are capped at 256 KiB
and results at 1 MiB. Drafts and results survive tab changes and moves; closing a tab discards
them. Existing read-only views continue to work. See the hub plugin README for the full form schema.

## Marketplace

The official catalogue is `https://raw.githubusercontent.com/TunneldeDev/tunnelde-hub/main/registry.json`,
maintained in the independent `TunneldeDev/tunnelde-hub` repository. The old `marketplace/index.json`
is a compatibility snapshot for older clients. Settings → Plugins can add up to 20 sources
including the official source. Custom sources are public HTTPS JSON catalogues and require an
explicit trust confirmation. Disabling or removing a source keeps its installed plugins.
Authentication-protected sources are outside this version's scope.

Every entry pins a download and its checksum:

```json
{
  "plugins": [
    {
      "id": "hello",
      "name": "Hello",
      "version": "0.1.0",
      "description": "Example plugin",
      "url": "https://github.com/<owner>/<repo>/releases/download/<tag>/hello-plugin.zip",
      "sha256": "<64 hex characters>"
    }
  ]
}
```

Entries may also include `author`, inline `readme`, `runtime`, `apiVersion` and `engines.node`.
Manifests use `readme` as a relative file path; the host reads its bounded content safely inside
the plugin directory. Node engine requirements use Rust semver version-range syntax.

The Plugins activity opens a searchable sidebar with Marketplace, Installed and Updates filters.
Selecting a result opens a reusable workspace detail tab. Downloads happen in Rust, independently
of webview CORS, and expose progress, cancellation and retry. HTTPS redirects are limited to five,
archives to 64 MiB, and unpacked packages to 64 MiB/2000 entries. Checksums are checked before
extraction; package ID, version, runtime and API must match the selected catalogue entry.
Checksums verify integrity, not publisher identity.

Catalogues are cached independently per source for five minutes. A failed refresh can show a
clearly marked offline snapshot with its original timestamp. A broken source does not prevent
other sources from loading. Invalid entries are ignored; malformed catalogue documents fail.

Installed plugins record the source ID and URL. Updates must come from that source and have a
newer version. Updates are manual: validate/stage first, stop the old plugin, replace atomically,
and restore the old package if replacement fails. Startup recovers interrupted replacements.
Installation and update leave the plugin stopped. Local plugins cannot be silently adopted by
a remote catalogue with the same ID. Source/runtime configuration is independent of appearance
and general preference resets.

Submit official plugins and themes by pull request to `TunneldeDev/tunnelde-hub`, including
source, manifest, README and regenerated `registry.json`. The three
initial tools—JSON Formatter, Timestamp Converter and UUID Generator—are independent, zero-npm
dependency Node plugins. Their archive builds are deterministic and include the repository
LICENSE. In the hub, `npm run verify` checks catalogue consistency, validator regressions,
algorithms and real JSON-RPC processes. `npm run package` produces ZIPs, SHA256SUMS and a
catalogue under `artifacts/plugins/`. Push/PR CI and weekly published-asset audits run separately
from desktop releases. Publish and verify versioned archives before merging registry changes.
Legacy official-source configuration and package origins migrate to the hub while preserving
custom sources and Node consent.

## Installing

The independent Codex, Claude Code, Pi and Tunnelde AI plugins in version 1.4.0 require
Tunnelde 0.26.0+. Select **Execution location** in the composer, then Initialize the agent
before sending. Remote POSIX hosts also offer an approved private **Install and initialize**
flow. Missing executables and account/setup errors appear beside the composer without
adding a failed user message; drafts are preserved and initialization can be cancelled.
Checks use each agent's native structured protocol over SSH, with no model prompt. They
do not guarantee future provider inference. Local coding CLIs still use their official
installers. Tunnelde never executes existing user Node without consent. See the hub's
`docs/assistant-plugins-1.4.md` for supported platforms, installation behavior and limits.

- **Plugins sidebar → Install plugin** copies a folder into the app data `plugins` directory after the
  manifest validates, and refuses to overwrite an existing id.
- A `.zip` archive works too: it is unpacked to a temporary folder, which must contain the manifest
  either at its root or inside a single top-level folder. Extraction refuses paths outside the
  target and caps the unpacked size.
- Pick a folder, pick an archive, or drop either onto the window while the dialog is open.
- **Reload** rescans the directory, stopping running hosts first.
- **Uninstall** stops the host and deletes the folder.
- `examples/plugins/hello` in the repository is a complete minimal plugin.
