# Plugin status bar API

[简体中文](plugin-status-bar.zh-cn.md)

Status bar v1 is a stable, additive API available from host 0.31.1. Use
`api.describe` to detect `statusBar.set` before calling it on older hosts.
No protocol version change is needed. Existing stable core contracts remain unchanged.

```js
await host.call("statusBar.set", {
  id: "connection",
  text: "Connected",
  alignment: "right",
  priority: 10,
  icon: "cloud",
  tooltip: "Open connection details",
  command: "open-details",
});
await host.call("statusBar.remove", { id: "connection" });
```

Register in the plugin's initialization handler, then update with the same ID as
its state changes. No view needs to be open. Executable plugins still require
consent; this API needs no additional domain permission. It grants no filesystem,
network or command-execution privileges. An executable Node plugin still requires
explicit permission to use a system Node runtime.

| Field       | Contract                                                                                                                   |
| ----------- | -------------------------------------------------------------------------------------------------------------------------- |
| `id`        | Required, 1–128 ASCII letters, digits, `.`, `_`, `-`; scoped to plugin and runtime                                         |
| `text`      | Required nonblank plain text, at most 128 Unicode code points                                                              |
| `alignment` | `left` (default) or `right`                                                                                                |
| `priority`  | Integer −1000 through 1000, default 0; descending, then deterministic plugin/item ID order; both groups read left to right |
| `tooltip`   | Optional plain text, at most 1024 code points; host prefixes the plugin identity                                           |
| `icon`      | Optional `activity`, `check`, `alert`, `info`, `sync`, `terminal`, `cloud`, `code`, `plug`                                 |
| `command`   | Optional own manifest command ID; editor and file-menu commands need document context and are excluded                     |

Omit an optional field or use `null` for tooltip/icon/command to clear it when
replacing an item. Updates replace the full item, not a partial patch. Unknown
fields are ignored for forward compatibility. Control and bidirectional override
characters are rejected; HTML, CSS and arbitrary images are not supported.

`set` returns JSON `null`; `remove` returns whether this runtime's item existed.
Limits are eight items per plugin and 128 overall. The host truncates visual width
with an ellipsis; tooltip/accessibility labels retain the plugin identity. Core
connection/task/restart/security/update controls retain their own slots and cannot
be overwritten or displaced by plugin priority.

Clicking executes the declared command without opening a result tab, passing the
usual `_locale` input. Show results through a contributed view or `ui.showMessage`.
A pending click disables that item. The host rechecks approval, package identity and
runtime generation after acquiring the command lock. It never starts a stopped
plugin to execute an obsolete button.

Items are transient: stop, crash, uninstall, update, permission revocation, restricted
mode or application restart removes them. A late exit from an older process cannot
remove replacement items. Recreated WebViews read the host snapshot; registrations
are not stored in user profiles. There are no new plugin-facing events in v1.

Known validation errors include `plugin.statusBar.invalidItem`,
`plugin.statusBar.unknownCommand`, `plugin.statusBar.limit`, and normal security or
RPC errors. A stale UI click returns `plugin.statusBar.expired`. The machine-readable
input/result/error schemas are embedded in `api.describe`, synchronized to the SDK,
and tested against a frozen v1 fixture. Breaking changes need a new contract or an
explicit compatibility migration; UI implementation details are not public API.
