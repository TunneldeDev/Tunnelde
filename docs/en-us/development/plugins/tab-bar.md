# Tab bar contributions

Plugins can register native **button**, **select** and **text** controls using
`host.tabBar.set(item)` and remove them with `host.tabBar.remove(id)`.
These methods have a stable v1 contract: use `host.describe()` to detect support
and inspect `contract.inputSchema`, `resultSchema`, `errorSchema` and
`commandContextSchema`. They have been available since 0.32.0-beta.6; older hosts
may expose them without a stability commitment. The frozen
[tab-bar contract](../../../../tests/fixtures/plugin-compat/tab-bar-v1.json) defines the
compatibility floor. `set` returns `null` and replaces the entire item, including
defaults for omitted fields. `remove` returns whether this runtime owned an item
that was removed; removing an absent item returns `false`.
The host owns rendering, focus, theme and sizing. Raw HTML, CSS and scripts are
not accepted. Core panels use the same tab-bar slot through
`useTabBarContribution(tabId, id, content, priority)`; registration follows the
component lifetime and late disposal cannot remove a replacement contribution.

Controls use a single 28 px action size, shared theme tokens and restrained group
separators. `placement: "leading"` inserts before the tabs; the default
`"trailing"` inserts after them, before the pane controls. `group` is an ASCII
identifier scoped to the plugin. Groups stay together and higher-priority groups
appear first. Use `showLabel: true` for an icon with a visible button title,
`tooltip` for a plain-text description (up to 512 characters), and `checked`
for a button's toggle state. A false `checked` remains an accessible unpressed
toggle. The plugin acknowledges changes by calling `set` again; the host does
not assume a command succeeded.

Narrow panes move lower-priority controls into **Tab actions** instead of hiding
them behind a scrollbar. Select options become radio menu entries and toggles
retain their checked state. Widening the pane restores inline controls. Plugin
identity remains in accessible labels and menu entries. The host prevents repeat
execution while a control is busy, including when its registration is replaced.

Core components can pass an optional fifth argument to `useTabBarContribution`:
`{ placement, group, overflowActions }`. `overflowActions` are equivalent native
menu actions; custom content without such actions remains inline. Never depend
on inline geometry for command correctness.

```js
await host.tabBar.set({
  id: "execution-target",
  kind: "select",
  title: "Execution target",
  command: "select-target",
  options: [
    { value: "local", label: "Local" },
    { value: "remote", label: "Remote" },
  ],
  value: "local",
  placement: "trailing",
  group: "execution",
});
```

For a labelled toggle, register a button with `icon: "follow"`,
`showLabel: true`, `checked: true` and a `tooltip`. These optional presentation
fields are included in the v1 contract. Check discovery before relying on them
on older hosts. Existing controls keep
trailing placement and icon-only buttons.

The command must be declared in this plugin's manifest and must not be an editor
or file-menu command. Buttons require a command; text controls cannot execute
commands. Selects require a command, 1–32 unique options and a selected value.
Command input includes `_tabBar: { itemId, tabId, tabKind, paneId, value }` plus
`_locale` (a string or `null`). Buttons receive a `null` value; selects receive
the newly requested option value. Context IDs are opaque, advisory identifiers;
plugins must still use
authorized editor/filesystem/SSH APIs to act on resources. Returning a new selected
state requires another `set` call; failed commands leave the current value intact.

Omitting `when` limits controls to the plugin's own views, including docked sidebar
views. `when: {}` targets every tab. `when: { tabKind: "editor" }` targets editor
tabs. The public kind of a plugin page is `"plugin"`, projected independently of
the internal workbench store. `when: { tabId: "sidebar:output" }` targets the Output panel. Conditions
combine with AND and are rechecked on click. `disabled: true` prevents execution.

IDs are plain ASCII letters/digits/`._-`, maximum 128 bytes. Titles and option
labels/values are plain text, maximum 128 characters. Priority ranges from -1000
to 1000, with higher values first and deterministic ID ordering for ties. Each
plugin may register eight controls, with 128 total per host. Controls are scoped
to runtime generation and removed after stop, crash, uninstall or revocation.
Every update replaces its opaque host click token; stale clicks are rejected.
After a WebView reload the host snapshot restores live controls without restarting
plugins. Changes use the internal `plugin://tab-bar-changed` snapshot event.
This is not a plugin-facing subscription: the RPC contract's `events` is empty.
Command execution still uses the current approval, runtime generation and command
declaration. A control is never authorization to access its target resource.
Layout, overflow geometry and the internal snapshot event are host implementation
details; the item and command data contracts remain independent of them.

Supported icon names: `activity`, `check`, `alert`, `info`, `sync`, `terminal`,
`cloud`, `code`, `plug`, `copy`, `clear`, `folder`, `file`, `wrap`, `follow`,
`play`, `pause`, `filter`. Errors include `plugin.tabBar.invalidItem`,
`plugin.tabBar.unknownCommand`, `plugin.tabBar.limit`, `plugin.tabBar.expired`
and `plugin.tabBar.invalidContext`, in addition to normal authorization errors.
Invalid items, missing commands and quotas normally use JSON-RPC `-32000`;
authorization failures use `-32001`. `remove` distinguishes a missing `id`
(`plugin.api.missing:id`), an invalid type (`plugin.api.invalid:id`) and an invalid
identifier (`plugin.tabBar.invalidItem`). Handle additional error messages and
ignore unknown response fields. Schemas validate structure; option-value uniqueness,
selection membership, command ownership and runtime limits are checked separately.

[简体中文](../../../zh-cn/development/plugins/tab-bar.md)
