# Plugin API compatibility and security

[简体中文](plugin-api.zh-cn.md) · [Plugin overview](plugins-overview.en-us.md) ·
[Detailed plugin guide](plugins.en-us.md)

This guide describes the current discovery contract and security boundaries for plugin
authors. For contribution formats, limits and individual methods, consult the detailed
guide and the SDK catalogue in the independent marketplace repository. The application
and SDK can be released independently: check the target host rather than assuming every
method in an SDK exists in every host version.

## Discovering capabilities

The manifest's `apiVersion: 1` identifies the protocol; it does not promise that all
methods or their payloads are stable. The host validates this version and any declared
`engines.tunnelde` range before execution. An authorized executable plugin can call
`api.describe` with an empty object to obtain protocol version `1` and the methods
available in that host. Discovery itself requires no domain permission, but the plugin
must be approved and running. Every later request is authorized separately; appearing in
the catalogue does not grant access.

Method descriptions include `name`, `permissions`, `params`, `description`, `stability`,
`since` and `deprecated`. Stable core methods also provide an optional `contract` with
`version: 1`, draft-07 JSON `inputSchema`, `resultSchema`, `errorSchema`, `knownErrors`
and `events`. `params` remains descriptive text. Schemas describe structural validity;
authorization, encoded byte limits and current runtime state are checked separately.
Older hosts can omit the contract or stability metadata; treat missing metadata as unknown.
Ignore additional fields and unrecognized stability values.

| Stability      | Meaning                                                                                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `stable`       | A compatibility commitment for the documented request, response and authorization behavior. `since` identifies the first host version. Compatible changes may add fields or methods. |
| `experimental` | Behavior and payloads may change; discover capabilities and handle failures.                                                                                                         |
| `deprecated`   | Consult `deprecated` for migration guidance.                                                                                                                                         |

The first stable core consists of `api.describe`, `sessions.list`, `storage.get`,
`storage.set` and `storage.delete`. These methods have been available since 0.21.0;
the `since` field records availability, not when this stability commitment was made.
The stable surface also includes `statusBar.set`/`statusBar.remove` and
`editor.active`/`editor.replace`. Editor methods have been available since
0.29.0-beta.2; their frozen v1 contract is now explicit. Settings, workspace mutation,
chat, runner and other panel methods remain experimental. `workspace.snapshot`
also has a frozen v1 read-only contract; workspace mutation methods remain experimental.
`tabBar.set`/`tabBar.remove` have a frozen v1 contract, including a separate
`commandContextSchema` for advisory click input. See the
[tab-bar guide](plugin-tab-bar.en-us.md) for defaults, lifecycle, scope and errors.
An incompatible change to a stable contract requires an explicitly versioned migration.
`log` also has a frozen v1 contract: legacy message/level calls remain available, and
structured logging requires 0.33.0-beta.5 or later. Its result acknowledges acceptance,
not durable delivery. See [logging](logging.en-us.md) for quotas, errors and filtering.

The frozen discovery [request schema](../tests/fixtures/plugin-compat/api-describe-v1-request.schema.json)
and [response schema](../tests/fixtures/plugin-compat/api-describe-v1.schema.json) define
its v1 compatibility floor. Discovery emits no events. CI validates a host-produced
response and checks the method's metadata and permissions. The separate frozen
[core v1 contracts](../tests/fixtures/plugin-compat/core-v1.json) define the other
stable methods. New fields may be added; consumers must ignore fields they do not know.

## Stable core behavior

| Method           | Permission      | Input and result                                                                                                      |
| ---------------- | --------------- | --------------------------------------------------------------------------------------------------------------------- |
| `api.describe`   | None            | Object parameters; returns protocol version and method descriptions.                                                  |
| `sessions.list`  | `sessions.read` | Object parameters; returns current authenticated SSH sessions, possibly an empty array. Saved hosts are not sessions. |
| `storage.get`    | None            | `{key}`; returns this plugin's JSON value, or `null` when absent. A stored JSON `null` has the same result.           |
| `storage.set`    | None            | `{key,value}`; accepts any JSON value including `null`; returns `null` after replacement.                             |
| `storage.delete` | None            | `{key}`; removes the value if present; returns `null` even when the key was absent.                                   |

All methods require a running, approved plugin and reject revoked or restricted runtimes.
Storage is isolated by plugin identity, persists across runtime restarts, and does not
require filesystem permission. Keys contain 1–128 ASCII letters, digits, dots, underscores
or hyphens; `__proto__`, `constructor` and `prototype` are reserved. Unknown object fields
are ignored. Requests are limited to 256 KiB of encoded UTF-8 JSON. The complete persisted
storage object, including all keys and JSON overhead, is also limited to 256 KiB; a request
that fits the request limit may still exceed the aggregate storage quota. These byte limits
are independent of the structural schemas. Storage writes replace the stored JSON file;
power-loss durability is not promised. None of these five methods emits events.

Session results contain `id`, `hostId`, `title`, `address`, `cols`, `rows` and `connectedAt`
(Unix epoch milliseconds). Internal terminal and connection-purpose fields are excluded.
Listing a session does not reserve it: later operations can fail if it disconnects.
`sessions.connect` uses the same result DTO but remains experimental.

Failed host calls return JSON-RPC `error` with integer `code`, string `message`, and usually
`data.code` identifying the error category. Invalid parameter objects or oversized requests
use `-32602`; authorization failures use `-32001`; domain, quota and IO failures use
`-32000`. Missing storage fields report `plugin.api.missing:<field>`, incorrect types
`plugin.api.invalid:<field>`, rejected keys `plugin.api.invalidStorageKey`, corrupt stored
data `plugin.api.invalidStorage`, and quota overflow `plugin.api.storageTooLarge`.
`knownErrors` lists recognized identifiers, not every possible IO message. The transport
may reject an oversized response with `-32002` and no `data`; callers must not require
`data` for every error. Handle additional error messages without parsing OS-specific text.

## Stable workspace snapshot

`workspace.snapshot` requires `workspace.read` and approved execution. It returns
`tabs`, `panes`, `activeId`, `activePaneId` and the recursive `layout`, projected into
independent protocol DTOs rather than forwarding internal store objects. Every array
and nested object is detached. The SDK's `PluginWorkspaceSnapshot` types are generated
from these DTO declarations and checked against the selected host during SDK sync.
The frozen [workspace v1 contract](../tests/fixtures/plugin-compat/workspace-v1.json)
defines required and optional fields. The method has existed since 0.21.0; that is
availability, not the date of this stability commitment.

Tabs preserve IDs, kind, title, host identity, pin/preview/hidden state and optional
file-pane metadata. File-pane source and session identifiers, path, offline state,
remote identity and documented view preferences are metadata only; no file contents,
editor drafts, credentials or arbitrary internal fields are returned. Hidden docked
panels remain in the snapshot so plugins can identify their remembered placement.
A pane's `activeId` and the global `activeId` can be `null`, including an empty group.

Layout leaves identify a pane; split nodes provide an ID, ratio, children and direction:
`row` places children horizontally, `column` vertically. Tab kinds and file-view option
strings are open vocabularies: tolerate unfamiliar values and ignore additional fields.
New fields may be added compatibly. Read-only snapshots do not reserve tabs, sessions or
paths and grant no file/SSH permissions; later actions can fail after state changes.
The host checks authorization before dispatch and after the reply, and bounds encoded
responses. A missing WebView/reply can time out; no application events are promised by
this method. The same projection is used by experimental workspace actions that return
a snapshot, without making their mutation behavior stable.

## Stable editor buffers

The frozen [editor v1 contract](../tests/fixtures/plugin-compat/editor-v1.json)
defines two methods with independent DTOs; internal store fields are never returned.

| Method           | Permission     | Input and result                                                                                                                                |
| ---------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `editor.active`  | `editor.read`  | `{}`; returns `null` if the focused tab has no ready editor, or `{tabId, documentId, version, path, name, content, dirty}`.                     |
| `editor.replace` | `editor.write` | `{tabId, documentId, version, text}`; returns `{tabId, documentId, version, dirty}` after comparing the current document identity and revision. |

A snapshot reads the open buffer, including unsaved edits, without reading the file
again. Loading, failed, disconnected or missing editors return `null`. A document with
more than 128 KiB of UTF-8 content fails with `plugin.api.frontend:editor.documentTooLarge`.
The active tab is the focused workspace tab; focusing a different panel does not imply
that a previous editor is still active. Retain its identity if an explicit command
continues work on that document.

Replacement is a single undoable buffer operation and never saves to disk. Changed text
increments the revision; identical text leaves the revision and undo history intact.
Undo/redo also advance the revision. A user edit, reload, close/reopen, or unavailable
buffer invalidates a previously captured identity/revision and produces
`plugin.api.frontend:editor.documentChanged`. Read again and let the user retry rather
than overwriting newer content. `dirty` compares the resulting buffer with its saved
baseline; it is not always `true` after replacement.

Replacement IDs must be nonempty, contain no NUL and fit 1,024 UTF-16 code units.
Versions must be nonnegative safe integers. Text may be empty, but must fit 128 KiB
after UTF-8 encoding. Unknown input fields are ignored; consumers must ignore future
result fields. Schema character lengths do not replace these encoding and state checks.
Bad fields use `plugin.api.frontend:invalid:<field>` with JSON-RPC code `-32000`;
authorization still uses `-32001`. Shared frontend bridge failures include
`plugin.api.busy`, `plugin.api.frontendTimeout`, `plugin.api.frontendClosed` and
`plugin.api.requestExpired`. These RPC methods emit no plugin events; they do not
subscribe the caller to buffer changes.

## Compatibility testing

CI loads a frozen v0.28.0 example through the current host's manifest loader and JSON-RPC
lifecycle. A separate, newly authored probe uses a frozen pre-contract SDK, with source
commit and SHA-256 recorded alongside it, to exercise the current host. Core schema checks
validate real storage results, session serialization and JSON-RPC errors, and reject
narrowed contracts or changed permissions. Editor checks execute the frontend bridge
against real buffer state, pass its captured results/errors through the Rust reply
encoder, validate the frozen schemas and replay the combined responses through the
historical SDK. Logging samples use the actual wire adapter and local writer, including legacy
`host.log(message, level)` calls through the frozen SDK, aliases, quotas, redaction,
identity and filtering. This exercises a defined core, not every
method, permission, event or stored-data migration. Test a plugin against the oldest
application version it declares, and again against newer hosts. Check for unavailable
methods, authorization changes and errors; do not depend on undocumented fields or a
fixed method count. The market SDK catalogue and `api.describe` can differ when their
releases are not synchronized.

## Approval and runtime boundaries

Installing an executable plugin leaves it stopped. Before execution, Tunnelde asks for
approval of its source and declared permissions. Approval is bound to the package's
SHA-256 fingerprint and permissions; changes or reinstallations require fresh approval.
Consent to use an existing system Node installation is separate. Node is not bundled
with the application; a user can instead explicitly select an executable or install a
private runtime. Declarative theme and icon contributions do not require Node.

Node plugins run with the user's operating-system privileges. Manifest permissions
govern the host API; they are **not an OS sandbox** and do not prevent direct filesystem,
process or network access by Node code. Restricted mode prevents application-managed
executable Node and WASM plugins from running and blocks their host API requests. It
cannot undo previous writes or external processes started by arbitrary code. Only run
plugins from publishers you trust.

Start with `--safe-mode` or `--restricted-mode` to force restricted mode for that process.
The setting persists; removing the argument alone does not restart plugins. Host/session
snapshots do not return saved SSH passwords or private keys, and plugin approval does not
replace SSH host-key verification. See the detailed guide for recovery behavior, limits,
WASM restrictions and platform-specific invocation.
