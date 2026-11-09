# Plugins

[简体中文](plugins.zh-cn.md)

Overview and compatibility: [English](plugins-overview.en-us.md) · [简体中文](plugins-overview.zh-cn.md).

API compatibility and security: [English](plugin-api.en-us.md) · [简体中文](plugin-api.zh-cn.md).

Editor command and formatter contributions:
[English](editor-plugins.en-us.md) · [简体中文](editor-plugins.zh-cn.md).

## Quick access and command results

The plugin browser renders up to 24 matching entries per page, with previous/next
navigation and a result count. Search accepts multiple words and exact `tag:pdf`
filters; comma-separated tags such as `tag:pdf,image` match any listed tag.
Separate terms such as `tag:pdf tag:preview` must all match.
Clicking a tag updates the search expression rather than adding another filter bar.
The current query, tag and page
survive opening a detail tab. Clicking a tag in details reveals the plugin browser.
Discovery reads metadata and does not start executable plugins. The static registry
fetch remains bounded to 2 MiB / 2,000 entries per source; archives download only
after installation is requested. This is UI pagination over cached metadata, not
a server-side paginated registry protocol.

Publishers may add a `tags` array to both manifests and registry entries. Up to 24
case-insensitively distinct tags are allowed, each at most 64 UTF-8 bytes, with
letters, digits, `_`, `-` and `.`. Old packages without tags remain compatible.

Press F1 and type `> ` followed by a plugin name or command to open a contributed
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
Arbitrary VSIX packages are not supported. Tunnelde plugins use this application's
manifest and host APIs. A VS Code extension expects the VS Code extension host,
workspace services, webviews and authentication APIs; unpacking its VSIX does not
provide those services. The independent coding plugins invoke the actual installed
agent binaries through their structured protocols.

The independent marketplace and source packages live in
[TunneldeDev/tunnelde-hub](https://github.com/TunneldeDev/tunnelde-hub). The marketplace
contains a range of independently installed extensions; inspect each extension's own
description, compatibility requirements and permissions before installation.

Executable plugins speak JSON-RPC 2.0 over stdio in separate processes. Pure theme packs contain only a manifest and theme colors; they do not start a process or require Node.

Startup errors offer **Open log**. A host-version mismatch reports the installed
plugin version, current Tunnelde version and the exact `engines.tunnelde` range,
before attempting to launch a runtime. Update Tunnelde or install a plugin version
compatible with your host. Older minimum versions also accept later compatible
host Betas; explicit upper bounds and minimum stable releases are still enforced.
Diagnostic logs record the compatibility stage and these versions rather than
only the internal error key. Installed plugins are independent of Node consent.

## SSHFS and data-only plugins (0.27.0+)

Mount providers can use the native mount panel, including declarative plugins that do not
need Node. Connect a saved SSH host first,
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
{ "views": { "main": { "title": "Remote mounts", "blocks": [{ "type": "mounts" }] } } }
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

| Field               | Required          | Description                                                              |
| ------------------- | ----------------- | ------------------------------------------------------------------------ |
| `id`                | yes               | Lowercase letters, digits, `-` and `_`, up to 64 characters              |
| `name`              | yes               | Display name                                                             |
| `version`           | yes               | `major.minor` or `major.minor.patch`                                     |
| `apiVersion`        | yes               | Must be `1`                                                              |
| `main`              | runtime dependent | Entry script inside the plugin folder; omit for pure theme packs         |
| `runtime`           | no                | `node` (default), `wasm`, data-only `theme` or `declarative`             |
| `description`       | no                | One line shown in the list                                               |
| `commands`          | no                | `[{ "id": "greet", "title": "Say hello" }]`                              |
| `views`             | no                | `[{ "id": "status", "title": "Status" }]`                                |
| `permissions`       | no                | Declared host API permissions; executable plugins require approval       |
| `themes`            | no                | One or more named palettes; icon-only and preview-only packs may omit it |
| `engines`           | no                | Version requirements for `tunnelde` and, for Node plugins, `node`        |
| `tags`              | no                | Searchable bounded tags, such as `["files", "preview"]`                  |
| `fileIconThemes`    | no                | Declarative filename and extension icon mappings                         |
| `filePreviews`      | no                | Declarative extension-to-renderer mappings                               |
| `mountedFileReveal` | no                | Opt in to revealing remote paths through this plugin's owned mounts      |

Runtime and engine requirements belong in manifest metadata and are shown by the
marketplace. Use Rust semver version-range syntax for engine requirements. A
`theme` runtime may contain themes, file icons or preview providers. Node commands
may declare `keybindings`, `macKeybindings`, `editor` and `fileMenu` contributions;
see [editor commands](editor-plugins.en-us.md) and the generated SDK for their
validation rules. The host lists contributed bindings only while the plugin is
installed. Conflicts can be retained, resolved by keeping one binding, or opened
in Keyboard Shortcuts with `@is:conflict` and `@plugins:plugin-id,another-id`.

Host version requirements include prerelease application versions while preserving
the declared comparator bounds. For example, `>=0.29.0-beta.2` accepts
`0.32.0-beta.4`, but `>=0.32.0` still rejects that Beta and `^0.31.0` does not
accept it. This lets compatible plugins run on newer public Betas without removing
their upper bounds. Node version requirements retain normal runtime SemVer rules.

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
`"runtime": "theme"`, omit `main` and Node engines, and have no commands, views or permissions:

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
scripts and invalid colors are rejected. A single non-executable pack can contain both
dark and light themes.

Installed palettes appear in Settings → Appearance and in the plugin detail page. Applying
one changes the base appearance, accent and full color map in one settings save; omitted
regions follow the base appearance. Installing a theme pack does not change the current
appearance. Removing or updating a plugin preserves already applied color values until the
user selects another theme. Executable plugins can contribute palettes without being started.

## File icon themes

Install a file icon theme from the marketplace, a ZIP or a folder. **Settings → Files → File icon
theme** offers Automatic, Plain file icons and installed themes. Automatic uses the first
available theme in plugin/theme ID order; choose a specific theme to preserve that selection
when installing other packages. Details pages also offer Apply theme. Removing a selected
package falls back to plain icons and retains its identity for later reinstallation.

Plugins contribute one or more `fileIconThemes` entries without running code:

```json
{
  "id": "my-icons",
  "name": "My File Icons",
  "version": "1.0.0",
  "apiVersion": 1,
  "runtime": "theme",
  "permissions": [],
  "fileIconThemes": [
    {
      "id": "common",
      "name": "Common files",
      "icons": {
        "typescript": { "symbol": "code", "color": "#3178c6", "label": "TS" },
        "archive": { "symbol": "archive", "color": "#c5a35e" }
      },
      "extensions": { "ts": "typescript", "tar.gz": "archive" },
      "fileNames": { "Dockerfile": "typescript" }
    }
  ]
}
```

Exact filenames match first, followed by the longest extension suffix; matching ignores
case. The same resolver serves local/remote file rows in every browser view, editor tabs
and file-preview headers. It reads filenames only. Folders keep the application's folder
glyph. Selection is included in settings exports and profiles.

Each package may contain up to 16 themes. A theme has up to 256 icon definitions, 512
extension mappings and 128 exact filename mappings. Definition/theme IDs use plugin ID
syntax; extension keys omit the leading dot. Optional `defaultIcon` names a defined icon.
Available symbols are `file`, `code`, `json`, `text`, `image`, `audio`, `video`, `archive`,
`pdf`, `spreadsheet`, `terminal`, `settings`, `key`, `database`, `font`, `binary`, `markdown`.
Colors must be six-digit HEX; optional labels contain 1–4 ASCII letters/digits. Unknown
symbols/references, duplicate case-insensitive mappings and excessive contributions are
rejected. Icons are host-rendered glyphs or short badges; manifests cannot inject SVG,
scripts, URLs, stylesheets or fonts. Data-only icon packs work in restricted mode and do
not require Node or file-access permissions. Executable plugins can contribute these same
metadata entries independently of their runtime.

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
generated host method catalogue in `sdk/api.md` and `sdk/api.json`.

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
`{version: 1, methods: [{name, permissions, params, description, stability, since, deprecated}]}`
for the running application. `stability` is one of `stable`, `experimental` or
`deprecated`. Stable methods include the first host version in `since`; deprecated methods
include migration guidance in `deprecated`. Only methods explicitly marked `stable` are
compatibility commitments. No domain permission is needed for API discovery, plugin-scoped storage
or plugin-identified notifications, but approval to execute the installed code is
still mandatory. Unknown methods and permissions are rejected.

The stable `api.describe` request takes an empty object and returns protocol `version: 1`
and an array of method descriptions. Existing `name`, `permissions`, `params` and
`description` fields remain available; clients must ignore additional fields and unknown
stability values. `params` is explanatory text, not a machine-validated schema. The call
requires an authorized running plugin and can fail if authorization is revoked, the runtime
is stopped, or normal JSON-RPC transport limits are exceeded. Its result is a snapshot:
each later call is independently authorized, and a listed method is not a grant. Hosts
released before stability metadata was added omit these fields; treat that state as unknown.
For stable methods, compatible versions preserve the documented request, response and
authorization behavior; additive fields and methods may be introduced. A breaking change
requires an explicitly versioned migration. Experimental methods make no such promise.

The frozen [request](../tests/fixtures/plugin-compat/api-describe-v1-request.schema.json) and
[response](../tests/fixtures/plugin-compat/api-describe-v1.schema.json) schemas define the v1
compatibility floor. Requests are also subject to the JSON transport size limit; clients should
send an empty object. Discovery emits no events. CI validates a response serialized by the host against its schema,
and checks the discovery method's permissions and metadata. The schema permits additive fields
and unknown stability values; it is not a schema for the other methods' request or result data.

The stable core now also includes `sessions.list` and plugin-scoped `storage.get`,
`storage.set` and `storage.delete`. Stable entries expose an optional versioned `contract`
with input, result and error JSON Schemas. See [API compatibility](plugin-api.en-us.md)
for field contracts, quotas, errors and the frozen pre-contract SDK regression probe.

| Permission                          | Available operations                                                                                                           |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `app.read`, `app.openExternal`      | App/platform metadata; validated HTTP(S) browser links                                                                         |
| `settings.read`, `settings.write`   | Read preferences; merge and validate preference patches                                                                        |
| `hosts.read`, `hosts.write`         | Saved-host/group metadata, create/update/delete, order and usage                                                               |
| `sessions.read`, `ssh.exec`         | Connected sessions; connect with normal host-key checks, disconnect, separate-channel command execution, terminal input/resize |
| `fs.read`, `fs.write`               | Local directory listing, UTF-8 text reads/writes, file/folder creation, rename, copy and deletion                              |
| `sftp.read`, `sftp.write`           | Corresponding remote file operations through existing SSH sessions                                                             |
| `editor.read`, `editor.write`       | Read and replace an open editor buffer with document/version checks                                                            |
| `mounts.read`, `mounts.write`       | Dependency checks and this plugin's owned SSHFS mounts                                                                         |
| `forwards.read`, `forwards.write`   | Saved forwarding rules and their listeners                                                                                     |
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

`tasks.readOutput` returns `status`, `exitCode` and an optional `error` from the same
snapshot as its sequenced output. The failure detail remains available after all
events have been drained. Display it when present instead of replacing SSH channel
or process errors with generic executable/login advice. Older hosts may omit this
field; `tasks.status` also exposes failure details. Drain terminal output before
reporting failure to preserve the agent's final protocol response.

Views may declare `location: "sidebar"`, `kind: "chat"` and an approved activity `icon` to
contribute a dockable controlled chat panel. `view.render` returns a `chat` block with session,
model and approval controls; subsequent `events.publish` messages carry sequenced chat updates.
The UI preserves drafts when a panel is moved. Secrets belong in `secrets.*`, never view data
or plugin storage. See the hub SDK for the schema and the extension's own documentation
for its supported controls.

Chat task entries may include a `runId` identifying the operation that owns their
saved recovery state. Live tasks, recoverable tasks and the current run's failures
remain visible; other terminal tasks appear in a collapsed history with a count
and failure indicator. Expanding history does not resume any task. Tool approval
details accept plain text or JSON; the host formats JSON for reading without
changing the approval request or decision.

Inspect/resume commands receive `taskId` and `taskRunId` from
that entry, alongside the current conversation `runId`. Plugins must validate all
provided identities before reading or continuing a process. A task whose saved
cursor has been replaced must stop offering recovery; its action must never
silently target a later process or a new operation on a reused runner.

Since 0.25.1, the controlled session picker provides searchable history with row-level
rename and delete actions. `commands.session` receives `action: "select" | "new" |
"rename" | "delete"`, a `sessionId` for an existing conversation, and `title` for a rename.
Rename/delete must operate on that ID without selecting a different conversation;
deleting the active conversation may select a remaining one. Empty or overlong names
must be rejected, and running conversations must reject deletion. Session entries can
include `untitled`, `updatedAt` (Unix milliseconds), `running` and `runId`. Use an empty
title plus `untitled: true` for a localized placeholder, and `untitled: false` for custom
names. Background terminal events matching the session's `runId` clear its running
indicator without changing the visible conversation.

Since 0.22.2, chat blocks may include a `title` and a `profilePolicy` containing
`primaryProtocols`, `reviewerProtocols` and `defaultProtocol`. The default must be one of
the primary protocols. The host uses these to show the plugin's identity and keep its
agent connections separate from approval-only API connections. Plugins must also enforce
their own fixed policy when loading, saving and executing configurations; view metadata
is not an authorization boundary. Each installed extension has its own views, storage,
permissions and runtime.

Remote runners require explicit confirmation, a separately selected native helper, a fresh
private remote directory and an explicitly chosen remote runtime. No service or Node runtime
is installed. Closing the app preserves remote tasks; stopping a plugin or entering restricted
mode records stop requests and retries unreachable hosts on SSH reconnect. Runner records bind
to a saved host, so reconnecting with a new session ID can recover the same task. See
[native helper setup](native-helper.md).

The optional `tunnelde-agent` executable supports MCP stdio and remote runners. Ordinary SSH,
SFTP, terminal and local API chat use does not require it. Helper source, platform binaries and checksums are maintained in the independent
[Tunnelde-agent repository](https://github.com/TunneldeDev/Tunnelde-agent). Its versions and
releases are independent of the desktop application. Helpers are not included in desktop
installers or the desktop GitHub Release downloads.

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
directories. Each Node process may have 32 host calls in flight, and the host may
have 32 command/view requests in flight to that process. Calls above either limit
fail with `plugin.api.busy` rather than growing an unbounded queue. An async Node
command does not block another command or view render; plugin authors must handle
overlapping callbacks and keep synchronous CPU work short. Stop, revocation and
process exit reject pending requests; a restarted plugin receives new request state.
Workspace requests
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

Plugin transfers use the same journaled staging and final publication as user transfers.
Events include an optional `pluginId` for attribution. Cancellation and revocation stop
new work and drain active writers before cleaning their temporary files. Cleanup that
requires a disconnected destination remains visible and retries on reconnection. After
an application restart, unfinished plugin transfers are cleaned up; they never resume
under an expired runtime's permissions. The task list allows cancellation, speed limits
and cleanup, but pause/resume belongs to user transfers. Start a fresh transfer from the
plugin when needed. Completed destination files and source files are retained.

`files.local.copy({from,to,overwrite?})` and
`files.sftp.copy({sessionId,from,to,overwrite?})` also use the journaled task
engine, with the same lease, cancellation, staging and publication rules. They
retain their existing completion contract: return `null` only after the worker
finishes, and reject on cancellation or failure. Directory copies commit each file
independently; files already committed are retained on failure. Cancelling a
pending `tools.invoke` copy signals cancellation and drains outstanding IO before
staging cleanup. Do not interpret a caller-side RPC timeout as proof of rollback.
For long transfers, prefer upload/download and poll their returned task IDs rather
than holding a copy RPC open beyond the SDK call timeout.

Poll `files.transferStatus({transferId})` to await completion before the next task.
It returns a transfer event with `running`, `done`, `failed`, `cancelled` or `cleanupPending`, or `null`
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
source, manifest, README and regenerated `registry.json`. Archive builds are deterministic
and include the repository LICENSE. In the hub, `npm run verify` checks catalogue consistency, validator regressions,
algorithms and real JSON-RPC processes. `npm run package` produces ZIPs, SHA256SUMS and a
catalogue under `artifacts/plugins/`. Push/PR CI and weekly published-asset audits run separately
from desktop releases. Publish and verify versioned archives before merging registry changes.
Legacy official-source configuration and package origins migrate to the hub while preserving
custom sources and Node consent.

## Installing

Each extension declares its own application version and runtime requirements. Review its
marketplace details and documentation for setup and supported execution locations. Tunnelde
asks for consent before using an existing system Node runtime.

- **Plugins sidebar → Install plugin** copies a folder into the app data `plugins` directory after the
  manifest validates, and refuses to overwrite an existing id.
- A `.zip` archive works too: it is unpacked to a temporary folder, which must contain the manifest
  either at its root or inside a single top-level folder. Extraction refuses paths outside the
  target and caps the unpacked size.
- Pick a folder, pick an archive, or drop either onto the window while the dialog is open.
- **Reload** rescans the directory, stopping running hosts first.
- **Uninstall** stops the host and deletes the folder.
- `examples/plugins/hello` in the repository is a complete minimal plugin.

## File preview providers

A package can contribute one or more `filePreviews` entries. This contribution is declarative:
Tunnelde owns rendering and file access; the plugin receives neither bytes nor preview tickets.
A package containing only themes/icons/previews uses `runtime: "theme"`, no `main`, commands,
views or permissions. It needs no Node runtime. Executable packages may also contribute providers.

```json
{
  "filePreviews": [
    {
      "id": "pictures",
      "name": "Pictures",
      "renderer": "image",
      "extensions": ["png", "jpg", "gif"]
    },
    { "id": "pdf", "name": "PDF", "renderer": "pdf", "extensions": ["pdf"] }
  ]
}
```

Renderers are `image`, `audio`, `video`, `pdf`, `markdown` or `text`. Provider IDs use the same
bounded plugin ID syntax; names are at most 120 UTF-8 bytes. A package has at most 16 providers,
each with 1–128 unique case-insensitive extensions of at most 64 ASCII bytes. No URLs, HTML,
scripts, styles or external viewers are accepted. Declare `engines.tunnelde` for a supporting build.

Select a file and press Space or use Preview. Matching is case-insensitive and supports compound
extensions. Multiple providers appear in a selector; otherwise installation is sufficient. Missing
binary providers offer a marketplace search for the `preview` tag. Built-in text/Markdown preview
continues working without a plugin. Installed providers refresh immediately after install/removal.

Native tickets use opaque UUIDs, expire after 30 idle minutes, are revoked on close/window destruction,
and retain opened file handles rather than resolving arbitrary protocol paths. At most eight tickets
and two concurrent requests per ticket are allowed. Requests support GET/HEAD and single byte ranges
capped at 1 MiB; multipart ranges are rejected. Whole-file reads are capped at 32 MiB. Revocation
interrupts queued/active reads; remote file and SFTP handles close without creating remote files.

Images are limited to 32 MiB, PDFs to 128 MiB, text/Markdown to 2 MiB; audio/video use bounded Range
requests. Playback depends on OS codecs and starts only on user action. PDF.js is lazy-loaded with
local fonts/CMaps/decoders, fetches ranges on demand, renders one page to a bounded canvas and does
not run document scripts or interactive forms. Password-protected PDFs require an external viewer.

[Stable plugin status bar API](plugin-status-bar.en-us.md)

[Tab bar contributions](plugin-tab-bar.en-us.md)
