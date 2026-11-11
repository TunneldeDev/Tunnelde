# Loaded editor buffer data

[简体中文](../../../zh-cn/development/plugins/editor-buffers.md) · [Editor commands](editor-plugins.md)

These experimental APIs complement stable `editor.active`/`editor.replace`.
Discover support with `api.describe`. Every call requires an approved live runtime
and the stated permission. They operate on loaded, ready buffers only; they never
open files, save to disk, reconnect or request new access.

| Method              | Permission     | Request                                        |
| ------------------- | -------------- | ---------------------------------------------- |
| `editor.observe`    | `editor.read`  | `{tabId?, revision?}`                          |
| `editor.readRange`  | `editor.read`  | `{tabId, documentId, version, offset, limit?}` |
| `editor.applyEdits` | `editor.write` | `{tabId, documentId, version, edits}`          |

Public DTOs in `contracts/editor/data/` are independent of store state and mirrored
to the marketplace SDK. Responses use `schemaVersion: 1`; buffer `version` is its
content revision. New methods reject unknown fields, null and invalid values.

## Observation and lifetime

`observe({})` captures the active ready buffer, or null for an unavailable or
non-editor tab. Specifying `tabId` observes that buffer independently of active
selection. Metadata contains only `tabId`, `documentId`, `version`, `path`, `name`,
`utf16Length` and `dirty`. Content, baseline, session and errors are excluded.

Initial/changed responses contain `{schemaVersion: 1, revision, changed: true,
snapshot}`. Reuse the opaque revision to receive only `{schemaVersion: 1,
revision, changed: false}` while unchanged. Tokens contain 1–128 UTF-8 bytes
without controls. Revisions bind the selector and captured metadata, including
dirty-only changes after saving; no content hashing or permanent cache is used.
Capture precedes asynchronous hashing: a newer state can exist on arrival. Use
the captured document identity and version for subsequent reads/writes.

This observes latest state; intermediate changes may coalesce. It is not an edit
event log. Closing/reopening or replacing a buffer changes `documentId`. Loading,
errored and disconnected buffers are unavailable. Selected files are not loaded
implicitly on a plugin's behalf.

## Bounded reads and atomic edits

Offsets and half-open ranges count UTF-16 code units. Read limits are 2–16384
(default 16384). Offsets cannot bisect a surrogate pair; page ends shorten to a
scalar boundary. Results contain identity/version, `offset`, `totalLength`,
`text` and `nextOffset` (null at EOF). Reading at EOF returns empty text. Pages
include unsaved text. Stale requests fail; restart pagination from fresh metadata.

An edit is `{start, end, text}` against the original buffer. Supply at most 128,
ascending, nonoverlapping edits with distinct starts and scalar boundaries.
Well-formed Unicode replacement text totals at most 64 KiB UTF-8; both
original and resulting buffers must each fit 2 MiB UTF-8, matching native saves
and the undo history budget. The complete batch validates
before one compare-and-swap mutation and one undo step. Empty/same-text batches
preserve version/history. Changed batches increment once; exhausted safe integer
versions fail before editing. Results contain `{schemaVersion: 1, tabId,
documentId, version, dirty, utf16Length}`. No saving or automatic retries follow.

`editor.documentChanged` requires re-reading and deciding whether edits still
apply. Validation errors start with `invalid:`. Size/version errors are
`editor.editTooLarge`, `editor.documentTooLarge`, `editor.versionExhausted`. Malformed existing buffer text fails with
`editor.invalidUnicode`; an explicit edit can repair it.
The existing frontend RPC transport wraps these as `plugin.api.frontend:<key>`.
Permission/runtime/cancellation errors still apply. A timeout or error after a
mutation starts is not evidence of rollback: observe/re-read before proceeding.

## SDK lifecycle

`createEditorBufferClient(host)` from `sdk/editor/client.mjs` exposes `observe`,
`readRange`, `applyEdits` and `subscribe`. Each call accepts transport options
`{signal?, timeoutMs?}`. Distribute `sdk/editor/`, `sdk/runtime/observation/` and
referenced declarations. There are no runtime dependencies or Node globals.
Supply an explicit authorized transport supporting cancellation/deadlines;
basic trusted-UI `api.call(method, params)` alone does not meet that contract.
No runtime is installed or selected by this facade.

`subscribe(receive, {signal, intervalMs?, tabId?})` requires an owner AbortSignal;
optional tabId stays fixed. It initially emits frozen metadata or null, then
changes only. Intervals are 1000–60000 ms (default 2000) after each read and async
receiver settle. Reads have a 10000 ms deadline; eight subscriptions per client,
without overlapping reads/callbacks per subscription. Cancelled unsettled work
remains charged. `stop()`/abort fence late replies; `closed` means delivery stopped;
`done` waits for settlement and resolves stopped/aborted/failed, never rejects.
Errors stop without retries. Bind cancellation to feature/view/plugin disposal
and inspect `done`. A transport ignoring cancellation/deadlines delays settlement;
work started inside callbacks needs its own cancellation.

Stable whole-document APIs retain their 128 KiB limit and behavior. This addition
does not change formatter commands, unify file/preview lifetimes, promise durable
streams or expand the stable API surface.
