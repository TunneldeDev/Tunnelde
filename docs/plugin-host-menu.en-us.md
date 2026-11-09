# Host menu commands

[简体中文](plugin-host-menu.zh-cn.md) · [Host decorations](plugin-host-list.en-us.md) · [UI SDK](plugin-ui.en-us.md)

The experimental `hostList.menu` extension point adds commands to the saved-host
list's right-click and more menus. Each action shows its plugin name. Built-in
actions remain available; menus merge in plugin-ID order, then manifest order.

Declare `hosts.read` and set `hostMenu: true` on a manifest command:

```json
{
  "permissions": ["hosts.read"],
  "commands": [{ "id": "inspect", "title": "Inspect host", "hostMenu": true }]
}
```

Node, WASM and trusted frontend commands can contribute. Theme and declarative
plugins cannot execute these commands. Frontend plugins also need their usual
`frontend` declaration and explicit `ui.trusted` permission. A command has one
resource context, so it cannot combine `hostMenu` with `editor` or `fileMenu`.
There are at most 16 host commands per plugin and 128 displayed actions overall;
titles have at most 120 characters and cannot contain control characters.

Discovery reports `registration.manifest: "commands[].hostMenu"` and
`ownership: "manifest"`. Installed metadata can be displayed without starting
the plugin or detecting Node. Selecting an action uses the normal permission and
runtime prompts; cancelling either prompt does not execute the command. Stopped
plugins can be activated on selection; uninstalling removes their menu entries.

The command receives `HostMenuCommandInput`, generated into the marketplace SDK:

```json
{
  "host": {
    "id": "saved-host-id", "name": "Server", "address": "example.org",
    "port": 22, "username": "operator", "groupId": null, "tags": ["prod"]
  }
}
```

This is a snapshot of the explicitly selected host. It excludes credentials,
private-key paths, notes and internal stores. If the host is removed or these
fields change during consent, the invocation fails and asks the user to reopen
the menu. The host and plugin fingerprint are checked again after consent.
Context is advisory, never authorization for an SSH connection or another API.
Every subsequent RPC retains its own permissions and runtime-generation checks.

The command palette and shortcuts use the saved host attached to the active tab
at invocation time. Without one, the host asks the user to open a host, terminal
or remote file tab. Changing focus while an action is queued does not retarget it.
Text results use the same bounded output page as file menu commands. Output from
a stopped, replaced or unapproved plugin is discarded.

Existing RPC contracts are unchanged. This adds a menu contribution, not host
sources, extensible columns, alternative host views or complete domain migration.
