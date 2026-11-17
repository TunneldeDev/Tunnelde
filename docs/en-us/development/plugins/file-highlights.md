# File-list highlights

[简体中文](../../../zh-cn/development/plugins/file-highlights.md) · [File browser data](file-browser-data.md)

File-list highlights are experimental. Discover `fileList.setHighlights` through
`api.describe` before use. Registration requires `fileBrowser.read` and
`workspace.write`, plus an approved, running plugin; it does not read file contents or grant filesystem
access beyond that permission.

```js
await host.call("fileList.setHighlights", {
  id: "generated",
  priority: 10,
  source: "local",
  highlights: [
    { match: { extension: "ts" }, tooltip: "Generated source", tone: "info" },
    { match: { pathPrefix: "/tmp/generated/" }, tooltip: "Temporary output", tone: "warning" },
  ],
});
await host.call("fileList.removeHighlights", { id: "generated" });
```

A collection replaces the previous collection with the same plugin-scoped ID.
An empty `highlights` array removes it. `setHighlights` returns JSON `null`;
`removeHighlights` returns whether this runtime owned a matching collection.

| Field       | Contract                                                                           |
| ----------- | ---------------------------------------------------------------------------------- |
| `id`        | Required, 1–128 ASCII letters, digits, `.`, `_`, `-`; scoped to plugin and runtime |
| `priority`  | Integer −1000 through 1000, default 0; higher priority wins                        |
| `source`    | `local`, a remote session ID (optionally `remote:<id>`), or empty for all sources  |
| `directory` | Optional exact listing path that scopes the collection                             |
| `match`     | Exactly one of `name`, `extension` or `pathPrefix`                                 |
| `tooltip`   | Optional plain text, at most 512 Unicode code points                               |
| `tone`      | `neutral` (default), `info`, `success`, `warning` or `error`                       |

`name` is an exact case-sensitive file name. `extension` is case-insensitive,
without a leading dot. `pathPrefix` is an exact path prefix. Directories never
match `extension` rules. Source-specific rules take precedence over global rules;
otherwise priority, plugin ID, collection ID and rule position determine the winner.

The host renders a semantic left marker, background tint and icon/name color;
plugins cannot submit CSS, HTML, arbitrary colors or image URLs. The first rule is
the visual winner. Tooltips and accessible labels include the plugin identity.
Highlights do not select files, change their metadata, persist into profiles or
affect file operations. They are removed on stop, crash, update, revocation,
restricted mode or application restart.

Limits are 256 rules and 256 KiB per collection, eight collections per plugin and
128 across all plugins. Invalid batches are rejected atomically. Known errors are
`plugin.fileList.invalidHighlight` and `plugin.fileList.limit`, plus ordinary
permission and runtime failures.
