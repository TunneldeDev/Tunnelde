# File browser providers

Ordinary plugins can also use [live browser data and actions](file-browser-data.md)
without registering a replacement interface provider.

[简体中文](../../../zh-cn/development/plugins/file-browser.md) · [Interface providers](ui-providers.md)

The experimental UI SDK supports `views[].provider: "fileBrowser"` for trusted
frontend components. Declare `ui.trusted`, `fs.read`, `sftp.read` and `workspace.write`.
Users choose a provider in Settings → Plugins → Interface providers; selection
never grants permission or bypasses approval. A plugin cannot select itself.

The host supplies `FrontendViewProps.fileBrowser` for each pane. Its immutable
`snapshot` contains pane identity, source, path, revision, visible count, selection,
loading and error. `read({ revision, offset? })` returns at most 256 entries in the
host's current filter/sort order; `nextOffset: null` marks the last page. Every page
requires its snapshot revision. Older contexts retain immutable data, but their
actions become invalid when the pane changes. No internal store, cache or credentials
are exposed. Reads continue to check provider authorization.

```js
export function activate(context) {
  const React = context.sdk.react;
  const { Button } = context.sdk.components;
  function Files({ fileBrowser }) {
    const { snapshot, Entries } = fileBrowser;
    return React.createElement(
      "div",
      {
        style: { display: "flex", flexDirection: "column", flex: 1, minHeight: 0 },
      },
      React.createElement(
        Button,
        {
          disabled: snapshot.busy || !snapshot.path,
          onClick: () => fileBrowser.refresh(),
        },
        `Refresh · ${snapshot.total}`,
      ),
      React.createElement(Entries),
    );
  }
  context.views.register("files", Files);
}
```

`Entries` is optional: mount it once to compose the live built-in listing, including
Finder columns, selection, column resizing, context menus and drag/drop. Its DOM
moves without remounting its React owner. Custom renderers can instead page through
`read`; they must implement accessible selection and keyboard interaction themselves.

| Action                  | Behavior                                                                            |
| ----------------------- | ----------------------------------------------------------------------------------- |
| `navigate(path)`        | Request navigation; completion or errors arrive in a new snapshot.                  |
| `refresh()`             | Refresh the current or pending directory.                                           |
| `select(paths)`         | Select entries in this visible revision; reject duplicate/foreign paths atomically. |
| `open(path)`            | Navigate into a directory or use the host's file editor/preview flow.               |
| `open(path, "preview")` | Preview a visible file through existing preview providers.                          |

Dispatch actions from handlers or effects after mounting, never during render.
Loading, unmount, changed revisions, stop, revocation and replacement invalidate
actions. Native filesystem and SSH checks still apply. Errors use
`plugin.fileBrowser.invalid`, `plugin.fileBrowser.busy`, `plugin.fileBrowser.changed`
or existing frontend availability errors. This trusted JavaScript runs in the host
context and is not a security sandbox.

Path, source picker, filter, toolbar, status and restore controls remain host-owned.
Inline create/rename temporarily uses the native listing. Stop, removal, restricted
mode or render failure restores the built-in listing while retaining its owner,
navigation, selection and column preferences. Existing file RPCs, formatters, icons
and previews remain compatible.
