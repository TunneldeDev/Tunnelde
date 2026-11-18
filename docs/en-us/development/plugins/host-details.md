# Host details

`hostDetails` contributes interactive cards, forms and controls to saved host details, independently
of scalar `hostFields`. Components use the existing trusted frontend module and `context.api.call`.
Each operation retains its normal API permissions.

```json
{
  "frontend": {"entry": "ui/index.mjs", "sdk": "^0.1.0"},
  "permissions": ["ui.trusted", "hosts.read", "mounts.read", "mounts.hostDetails"],
  "views": [{"id": "mounts", "title": "Mounts", "kind": "component"}],
  "hostDetails": [{"id": "mounts", "title": "Mounts", "viewId": "mounts", "kind": "mounts"}]
}
```

Up to eight contributions per plugin, with unique IDs. Each `viewId` must reference an ordinary
component view belonging to the same plugin, without a provider target. All sections require
`frontend`, `ui.trusted` and `hosts.read`. Omit `kind` for an ordinary section; these compose in
plugin ID order. `kind: "mounts"` additionally requires `mounts.read` and `mounts.hostDetails`.
A contribution does not start the plugin or authorize API writes.

Register using `context.views.register(viewId, Component)`. The host supplies
`props.hostDetails = {hostId, contributionId, kind?}`. Changing hosts disposes the old component
and its `props.resources`. Stop, replacement, revocation and restricted mode remove the section.

Choose **Host mounts** in the plugin UI provider settings. The setting
`mountHostDetailsSelection: {pluginId, contributionId} | null` uses the native
`MountHostDetailsSelection` type. Only the selected mount contributor renders. Selection changes
presentation; it must not duplicate shared rules or stop host-owned connections. `settings.get`
and `settings.update` expose this preference with `settings.read` and `settings.write` respectively.
Restoring the built-in workspace clears the selection.

Discover support through `extensions.describe().hostDetails`. Use published API methods for
operations; new native features should expose their reads, edits, runtime controls, batch operations
and observations through the same domain services. `api.describe` lists implemented methods and
permissions. Host fields are not an arbitrary HTML or interactive form renderer.

`forwards.automation.list` returns the native forwarding panel's revisioned rules, runtime identities,
auto-start/retry options and recovery status. Save using
`forwards.automation.save({id, expectedRevision, automation:{autoStart,autoRetry}})`; stale revisions
fail without changing the rule. Legacy `forwards.list` and `forwards.save` contracts remain unchanged.
Automation preferences are persistent host configuration, retained when the plugin stops or loses
permission. Auto-start takes effect on the next application launch; saving does not connect immediately.

`forwards.startMany({sessionId, items:[{id, expectedRevision}]})` requires `forwards.write`. Pass up to 16 distinct rules with revisions from `forwards.automation.list` and an existing authenticated session for the rules' host. Results are returned in input order as `{id, status:"started"}`, `{id, status:"failed", error}`, or `{id, status:"notStarted"}` for rules not attempted within the 90-second batch budget. Listener setup or revision errors affect only their own rule. Cancellation does not undo committed starts; plugin retirement or permission revocation still disposes its listeners. This API never creates an SSH session or switches a rule to a different host.
