# Command-history provider (experimental)

A trusted frontend can declare a component view with `provider: "history"`.
It requires `ui.trusted`, `sessions.read` and `history.read`. The user selects it in
Settings → Interface providers. Installation alone never replaces the native history.
The frontend runs in the host context, not a sandbox. Command history can contain secrets.

```json
{
  "runtime": "frontend",
  "frontend": { "entry": "ui/index.mjs", "sdk": "^0.1.0" },
  "permissions": ["ui.trusted", "sessions.read", "history.read"],
  "views": [{ "id": "history", "title": "History", "kind": "component", "provider": "history" }]
}
```

Complete this fragment with the normal identity and version fields. Register the view
with `context.views.register("history", View)`. Its `FrontendViewProps.history` context
belongs to one history panel and its connected host. It grants no access to other hosts.

```js
export function activate(context) {
  const React = context.sdk.react;
  function View({ history }) {
    return React.createElement(
      "section",
      { style: { display: "flex", flexDirection: "column", flex: 1, minHeight: 0 } },
      React.createElement("span", null, history.snapshot.title),
      React.createElement(history.Entries),
    );
  }
  context.views.register("history", View);
}
```

`Entries` optionally composes the persistent native list and its normal user-operated
actions. Mount it at most once. Restoring the native interface retains those same rows.
Omitting it allows a fully custom list. The host keeps search, count, clear confirmation,
load errors, retry and provider recovery outside the extension. A render failure,
stop, revocation or restricted mode restores the built-in list. Switching never starts
a new SSH connection or enables automatic history recording.

`snapshot` is an independent immutable DTO: `sessionId`, `hostId`, `title`, `revision`,
`query`, `total`, `busy` and `error`. `total` counts entries matching the current search.
The panel loads all retained entries, at most 500, newest first. The native RPC default
remains 200; its wire contract is unchanged. Search and loading changes create a new
revision and new view props. There is no separate streaming subscription to manage.

`read({ revision, offset? })` reads up to 128 entries and 65536 UTF-16 command units.
It returns `{ revision, total, nextOffset, items }`; `nextOffset` is `null` at the end.
Rows contain `id`, `hostId`, `command`, `executedAt` and `truncated`. Timestamps use Unix
milliseconds. Commands are not split across pages. Legacy oversized data is capped at
4000 UTF-16 units and marked `truncated`; the provider cannot execute those truncated
commands. Normal recording already rejects commands exceeding 4000 UTF-8 bytes.
Pass the exact revision; restart from the latest context after `plugin.history.changed`.

`setQuery(query)` uses the host's `@command:` and `@date:` filters, with a 4096 UTF-16
unit limit. Bare `command:value` is ordinary text. `refresh()` requests authoritative
data. Invalidation during a pending load collapses into one trailing read; late results
from an old host or panel are ignored. Events are dirty hints, not durable acknowledgments.

`capabilities` declares `delete`, `clear` and `execute`. `delete(id)` requires
`history.write`; `requestClear()` requires the same permission and opens native user
confirmation. Confirmation rechecks provider authorization and session identity.
`execute(id)` requires `ssh.exec` and immediately sends that existing command to this
session. It is not a preview or a shell execution result. Automatic recording still
honors **Record terminal history**. The default read-only manifest above cannot call
these mutation methods. The native row controls remain explicit user actions.

Operations only accept entries visible in the current revision. Loading or failed
history blocks destructive actions; filtering and retry remain available. Methods
recheck current selection, runtime generation, fingerprint, approval and permissions.
Retained contexts fail after replacement or close. Async methods reject on errors;
handle them and show translated diagnostics. Trusted code is not sandboxed and
revocation cannot undo a command already sent.

No system Node is required. This additive UI SDK remains experimental and does not
make the entire terminal/history domain stable. See [history semantics](history.en-us.md).
