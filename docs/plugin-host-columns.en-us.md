# Host table columns

The built-in Hosts panel offers tree and table views in its **Host view and columns** menu. The tree remains the default. In the table, users can show or hide columns, drag headers to reorder them, and drag the visible separators to resize. Clicking a header cycles ascending, descending and default order. Keyboard users can move a column with Alt+Left/Right and resize its separator with Left/Right, Home or End. The name column stays pinned during horizontal scrolling and remains first and visible so host actions are always reachable. Settings → Workspace also offers the view choice and a column reset.

Display choices are saved in `hostList` and included in settings exports and profiles. Plugin column keys are namespaced as `plugin/<pluginId>/<columnId>`. Stopping or uninstalling a plugin removes its columns without erasing their saved display choices. Reinstalling the same contributor can restore those choices. An unavailable sort column falls back to the normal host order. Text uses natural comparison, numbers use numeric comparison and booleans sort false before true. Missing cells sort last in either direction. The table uses the same host selection, search, context menus and connection behavior as the tree; manual host ordering remains a tree operation.

The experimental `hostList.columns` extension supports runtime-owned plain data columns. Both `hosts.read` and `workspace.write` must be declared and granted. Register or replace a complete column with:

```ts
await context.api.call("hostList.setColumn", {
  id: "budget",
  label: "Monthly budget",
  type: "number",
  width: 140,
  cells: [{ hostId, value: 0, tooltip: "Budget in the configured currency" }],
});
await context.api.call("hostList.removeColumn", { id: "budget" });
```

`setColumn` returns `null`. `removeColumn` returns whether this runtime removed an existing column. IDs contain 1–64 ASCII letters, digits, dot, underscore or hyphen. Labels contain 1–120 Unicode code points, widths are whole pixels from 64 to 480 (default 140). Types are `text`, `number` and `boolean`; all cells must match the declared type. Text accepts up to 512 code points, including empty strings; numbers must be finite. Optional tooltips contain 1–512 code points. Labels, text and tooltips reject control and bidirectional override/isolate characters. Unknown properties, duplicate or unknown host IDs, null values and type mismatches reject the entire replacement. A column may contain at most 256 distinct saved hosts. Missing cells display as unset; `0`, `false` and empty text retain their values. Empty `cells` keeps the declared column. HTML, CSS and executable cell renderers are not part of this API.

A plugin can register at most 8 columns, with 128 globally. Serialized column JSON is bounded to 512 KiB per plugin and 4 MiB globally. Replacement validates aggregate quotas under the registration lock, excluding the replaced entry; failure retains the previous column. Contributions are bound to the authenticated plugin fingerprint and runtime generation. Stop, crash, replacement, revocation, restricted mode and uninstall remove them. A late exit from an older runtime cannot remove a replacement runtime's column. Recreated WebViews reload an authoritative snapshot; queued snapshots from before a security change are ignored. This presentation API does not create saved hosts, own SSH connections or provide a plugin subscription contract.

Known validation errors are `plugin.hostList.invalidColumn`, `plugin.hostList.hostNotFound` and `plugin.hostList.limit`, alongside ordinary permission and runtime errors. API discovery and the extension directory describe this capability; the SDK synchronizes the DTO independently of the internal table implementation. The methods remain experimental and do not change `apiVersion` or existing stable core contracts.
