# Plugins

Plugins are folders that speak JSON-RPC 2.0 over stdio. Each plugin runs in its own process.

## Layout

```
hello/
  tunnelde-plugin.json
  index.js
```

`tunnelde-plugin.json`:

| Field | Required | Description |
| --- | --- | --- |
| `id` | yes | Lowercase letters, digits, `-` and `_`, up to 64 characters |
| `name` | yes | Display name |
| `version` | yes | `major.minor` or `major.minor.patch` |
| `apiVersion` | yes | Must be `1` |
| `main` | yes | Entry script, resolved inside the plugin folder |
| `description` | no | One line shown in the list |
| `commands` | no | `[{ "id": "greet", "title": "Say hello" }]` |
| `views` | no | `[{ "id": "status", "title": "Status" }]` |
| `permissions` | no | Only `log` is recognised today |

The host runs the entry with Node (`TUNNELDE_NODE` overrides the executable), so any runtime
available to Node works. The process is killed when the plugin is stopped, uninstalled or the app
quits.

## Protocol

One JSON object per line on stdin and stdout. stderr is logged and never parsed.

Host → plugin requests (the plugin answers with `result` or `error`):

| Method | Params | Expected result |
| --- | --- | --- |
| `initialize` | `{ apiVersion, pluginId }` | Any value; `{ "ok": true }` is typical |
| `command.run` | `{ command }` | Any JSON value, shown in the plugin list |
| `view.render` | `{ view }` | `{ title?, blocks: [...] }` |
| `shutdown` | `{}` | Any value, then exit |

Plugin → host notifications use the same framing without an `id`:

```json
{ "jsonrpc": "2.0", "method": "log", "params": { "level": "info", "message": "ready" } }
```

Timeouts: 8 seconds for `initialize`, 20 seconds for everything else.

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

## Marketplace

`marketplace/index.json` in the repository is the catalogue. Every entry pins a download and its
checksum:

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

Settings → Plugins lists the catalogue and installs an entry by downloading the archive in the
webview and handing the bytes to Rust, which verifies the checksum before unpacking. The content
security policy only allows the GitHub hosts that serve the catalogue and its release assets.
Submitting a plugin is a pull request against that file.

## Installing

- **Settings → Plugins → Install** copies a folder into the app data `plugins` directory after the
  manifest validates, and refuses to overwrite an existing id.
- A `.zip` archive works too: it is unpacked to a temporary folder, which must contain the manifest
  either at its root or inside a single top-level folder. Extraction refuses paths outside the
  target and caps the unpacked size.
- Pick a folder, pick an archive, or drop either onto the window while the dialog is open.
- **Reload** rescans the directory, stopping running hosts first.
- **Uninstall** stops the host and deletes the folder.
- `examples/plugins/hello` in the repository is a complete minimal plugin.
