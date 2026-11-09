# Host-list extensions

[简体中文](plugin-host-list.zh-cn.md) · [Extension architecture](plugin-extension-architecture.en-us.md)

Host decorations are experimental. Discover `hostList.setDecorations` through
`api.describe` before use; discover combination rules through `extensions.describe`.
Both methods require `hosts.read` and `workspace.write`, in addition to an approved,
running plugin. Reading an extension directory does not grant these permissions.

```js
await host.hostList.setDecorations({
  id: "environment",
  priority: 10,
  decorations: [
    {
      hostId: savedHost.id,
      badge: "Production",
      description: "Deployment ready",
      icon: "server",
      tone: "success",
    },
  ],
});
await host.hostList.removeDecorations("environment");
```

A collection replaces the previous collection with the same plugin-scoped ID.
An empty `decorations` array removes it. `setDecorations` returns null;
`removeDecorations` returns whether this runtime owned a matching collection.
IDs use 1–128 ASCII letters, digits, dots, underscores or hyphens. Priority is
an integer from -1000 to 1000, default 0. Each plugin may own eight collections,
with 128 across all plugins; each collection holds at most 256 distinct saved hosts.
Every referenced host must exist when the collection is registered. An invalid
entry rejects the whole collection without replacing its previous value.

`badge`, `description` and `tooltip` are optional plain text with maximum lengths
of 16, 160 and 512 Unicode code points. Null clears an optional field. Blank text,
control characters and directional override/isolation characters are rejected.
At least one badge, description or icon is required per host. Icons are `server`,
`cloud`, `container`, `database`, `globe`, `code`, `terminal`, `shield`, `key` and
`activity`. Tones are `neutral` (default), `info`, `success`, `warning` and `error`.
Arbitrary HTML, CSS and image URLs are not accepted by this decoration API.

Higher priority wins the icon and description independently; ties sort by plugin
ID and then collection ID using ordinal ordering. Badges combine in that order;
two are visible and the remaining count has an overflow tooltip. Tooltips preserve
plugin identity. Host names, addresses, saved color markers and connection controls
remain host-managed. Decorations do not mutate saved host records or persist into
profiles. They are removed on stop, crash, replacement, uninstall or revocation.

Known errors are `plugin.hostList.invalidDecoration`, `plugin.hostList.hostNotFound`
and `plugin.hostList.limit`, plus ordinary permission and runtime failures. The
runtime registration is independent of a mounted frontend; a recreated WebView
retrieves current contributions. Security changes clear visible contributions
before an authoritative refresh, ignoring queued pre-change snapshots.

This API is one implemented presentation extension. Dynamic host sources, extra
columns, full view providers and workbench replacement are separate capabilities;
the existence of decorations does not imply those capabilities are available.
