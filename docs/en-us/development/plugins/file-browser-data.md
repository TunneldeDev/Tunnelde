# Live file-browser data and actions

[简体中文](../../../zh-cn/development/plugins/file-browser-data.md) · [Interface providers](file-browser.md)

Ordinary plugins can discover and control existing file browsers without replacing
their renderer. These three RPCs are experimental; check `api.describe` on the
running host before use. Existing file IO and UI provider contracts are unchanged.

| Method                | Permission          | Result                                                            |
| --------------------- | ------------------- | ----------------------------------------------------------------- |
| `fileBrowser.observe` | `fileBrowser.read`  | Committed browser metadata and a conditional catalogue revision.  |
| `fileBrowser.read`    | `fileBrowser.read`  | Visible entries with selection flags from an exact pane revision. |
| `fileBrowser.action`  | `fileBrowser.write` | `{accepted:true}` after dispatch to existing host behavior.       |

Metadata includes ephemeral `paneId`, optional `tabId`, source, current path, revision,
visible count, selection count, busy/suspended state and bounded error text. It
contains no file contents, full selection, credentials, preview tickets or private
store fields. `selectedCount` can exceed the visible count when selection survives
filtering. A remote source has the existing session ID; discovery does not connect
hosts or grant filesystem access.

`observe({offset?,limit?,revision?})` defaults to offset 0/limit 16 and permits at most
32 browsers per page. Its conditional token is bound to the catalogue and exact
offset/limit. An unchanged response has no `snapshot`. `snapshot.nextOffset` is
either the next offset or `null`; reaching a byte limit can yield fewer items than
the requested limit. Pages are captured independently: catalogue changes between
pages can shift ordering. Restart discovery when a consistent enumeration matters.

`read({paneId,revision,offset?,limit?})` defaults to 64 entries and permits at most 256. It follows the current host filter/sort order and requires the exact live pane
revision on every page. Entries include name, path, directory/hidden flags, size,
modified time (Unix milliseconds or null), permissions (or null), and `selected`.
Numeric fields must be safe JavaScript integers. Both kinds of page are bounded to
64 KiB serialized UTF-8. Tokens permit 1–128 UTF-8 bytes without controls, paths
1–32768 bytes without NUL, names at most 4096 bytes. Error text is at most 2048 bytes;
`errorTruncated` explicitly marks truncation. JSON Schema character limits do not
replace these byte and pagination checks.

Every action requires `paneId` and `revision`:

| Action     | Additional fields                            | Behavior                                                                                                |
| ---------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `refresh`  | None                                         | Request the existing host refresh.                                                                      |
| `navigate` | `path`                                       | Request navigation through the existing path handling.                                                  |
| `select`   | `paths`                                      | Select at most 256 distinct visible entries; empty clears selection.                                    |
| `open`     | `path`, optional `mode: "open" \| "preview"` | Open a visible file in the existing editor/preview flow; a directory navigates and cannot be previewed. |

Busy/suspended browsers reject actions. A changed source, revision or closed pane
invalidates old requests. The native broker checks approval, permission, runtime
generation and cancellation; actions recheck authorization and live state just
before dispatch. Acceptance is not IO completion. Observe subsequent state and
host error reporting; never automatically replay an action after a lost response.
Errors include `plugin.fileBrowser.invalid`, `.changed`, `.busy` and native permission,
cancellation or response-size errors. The catalogue is committed UI state, not an
atomic filesystem snapshot or a durable authority to mutate paths.

The marketplace SDK exposes a separate classified facade:

```js
import { createFileBrowserClient } from "./sdk/files/browser/client.mjs";
const browsers = createFileBrowserClient(host);
const observation = await browsers.observe();
const pane = observation.changed && observation.snapshot.items[0];
if (pane && !pane.busy && !pane.suspended) {
  const page = await browsers.read({ paneId: pane.paneId, revision: pane.revision });
  const file = page.items.find((entry) => !entry.isDir);
  if (file)
    await browsers.action({
      paneId: pane.paneId,
      revision: pane.revision,
      action: "open",
      path: file.path,
    });
}
```

`subscribe(receive,{signal,offset?,limit?,intervalMs?})` observes one selected catalogue
page, default every two seconds (range 1–60 seconds). The owner signal is required;
receivers run serially, intermediate changes may coalesce, and there are eight
subscriptions per client. Stop/abort prevents further delivery; `done` reports
stopped/aborted/failed. Work retains its quota until it settles. Reads and mutations
also accept signal/timeout options. Results are detached and frozen; actions are
never retried by this facade.

Canonical wire DTOs live under `src/lib/extensions/contracts/files/browser/`; the
independent schema is `src-tauri/src/plugins/api/domains/files/browser/schema.json`.
SDK sync checks both. CI executes the real frontend bridge and consumes its serialized
results through that schema and the pinned SDK. File contents, preview resources,
safe copy-based moves/deletion and durable filesystem receipts remain separate APIs.
