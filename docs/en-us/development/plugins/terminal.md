# Terminal provider (experimental)

A trusted frontend may declare a component view with `provider: "terminal"`.
It requires `ui.trusted`, `sessions.read` and `ssh.exec`. The user explicitly selects
the provider in Settings → Interface providers; installation never replaces terminals.
The frontend runs in the host context, not a sandbox. Terminal text may include secrets
and `send` or `paste` can execute commands with the connected user's privileges.

```json
{
  "runtime": "frontend",
  "frontend": { "entry": "ui/index.mjs", "sdk": "^0.1.0" },
  "permissions": ["ui.trusted", "sessions.read", "ssh.exec"],
  "views": [{ "id": "terminal", "title": "Terminal", "kind": "component", "provider": "terminal" }]
}
```

This is a manifest fragment. Complete it with the normal plugin identity/version fields.
Register the component with `context.views.register("terminal", View)`. Its
`FrontendViewProps.terminal` context belongs to this specific terminal session.

```js
export function activate(context) {
  const React = context.sdk.react;
  function View({ terminal }) {
    const [state, setState] = React.useState(() => terminal.readState());
    React.useEffect(() => terminal.subscribe(() => setState(terminal.readState())), [terminal]);
    return React.createElement(
      "section",
      { style: { display: "flex", flexDirection: "column", flex: 1, minHeight: 0 } },
      React.createElement("span", null, `${state.cols} × ${state.rows} · ${state.status}`),
      React.createElement(terminal.Screen),
    );
  }
  context.views.register("terminal", View);
}
```

Mount `terminal.Screen` synchronously exactly once and keep it mounted. It moves the
live native screen without reopening SSH, clearing the buffer or replacing its renderer.
The host retains its connection controls and recovery bar. Omission, duplicate mounting,
render failure, stop, revocation or restricted mode restores the built-in terminal.
Use a flexible container with available height; the terminal fits its actual dimensions.

`readState()` returns an independent immutable snapshot of session identity, title,
status (`starting`, `ready`, `suspended`, `closed`), revision, geometry and active buffer.
`readLines({ revision?, offset? })` reads parsed buffer text, never raw control sequences.
The default offset is the current viewport; pages contain at most 128 rows, 4096 UTF-16
units per row and 65536 units in total. Rows report explicit truncation. Pages do not
split rows to fill the remaining budget. `nextOffset` is the next row or `null`.
Pass the original revision for subsequent pages; on `plugin.terminal.changed`, restart
from the latest snapshot. Old scrollback may be evicted normally.

`subscribe(callback, { signal? })` reports immutable dirty notifications coalesced over
100 ms, with at most 16 subscriptions per terminal. It is not a lossless output stream.
Read a fresh snapshot after notification; notifications identify output, selection,
scroll, resize and status changes. Release the returned disposer or abort the signal.
The host also removes subscriptions on provider replacement, unmount and revocation.
Throwing callbacks are removed and recorded in software logs.

`readSelection()` returns text capped at 65536 UTF-16 units with `truncated`; it does
not read the clipboard. `focus()`, `clearSelection()` and `scrollToLine(row)` use the
native screen. `paste(text)` uses the negotiated bracketed-paste path, while `send(text)`
injects raw terminal input; neither returns a shell execution result. Nonempty input is
limited to 65536 UTF-16 units. Input is rejected until ready and while suspended or
closed. Parsed text remains readable after remote close while the screen exists.

Contexts are fenced by the selected provider, runtime generation, fingerprint and
current approval. Retained contexts fail after replacement or close. These checks do
not sandbox trusted code or undo commands already sent. No system Node is required.

This additive UI SDK capability remains experimental; it does not stabilize the entire
terminal/history domain or add a raw output recording API.
