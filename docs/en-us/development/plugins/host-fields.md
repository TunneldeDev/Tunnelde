# Plugin host fields

Plugins can declare optional, nonsecret host metadata in `hostFields` in their manifest. Tunnelde renders a collapsed group in host details for each installed contributor. Expand a group to load its values. Editing does not start a plugin, execute its code, grant permissions or use Node.

```json
{
  "permissions": ["hosts.read", "hosts.write"],
  "hostFields": {
    "version": 1,
    "fields": [
      { "id": "owner", "label": "Owner", "type": "text", "maxLength": 120 },
      { "id": "managed", "label": "Managed", "type": "boolean" },
      {
        "id": "tier",
        "label": "Tier",
        "type": "select",
        "options": [
          { "value": "production", "label": "Production" },
          { "value": "test", "label": "Test" }
        ]
      }
    ]
  }
}
```

The schema is experimental, versioned separately from `apiVersion`. It supports `text`, `number`, `boolean` and `select`. `description` is optional. Text accepts `maxLength` (1–4096 Unicode code points; default 4096); numbers accept finite `minimum` and `maximum`. Selects have 1–64 unique choices. A plugin can declare 1–32 unique field IDs (1–64 ASCII letters, digits, dot, underscore or hyphen). Labels are plain text up to 120 code points; descriptions up to 512. Unknown schema properties, control characters in labels and invalid type constraints are rejected. All values are optional: omit a key to unset it. Empty text, `false` and `0` are distinct from an unset value. `null`, unknown keys, and values of the wrong type are rejected. Credentials belong in the secrets API, never these fields.

The extension directory advertises `hosts.fields`. `hosts.getFields({hostId})` requires declared and granted `hosts.read`. It returns `{schema, document}`. The document contains `hostId`, `revision`, `schemaDigest`, `schemaVersion`, `storedSchemaVersion`, `schemaChanged` and `values`. A new document has revision 0 and no stored schema version. Data is scoped to the authenticated plugin identity and host ID; callers cannot supply another plugin ID.

`hosts.setFields({hostId, expectedRevision, schemaDigest, values})` additionally requires `hosts.write`. It replaces the whole value map and returns the same snapshot shape. Both the exact current schema digest and document revision must match. Revisions increase even when clearing all values. `hostFields.conflict` and `hostFields.schemaChanged` leave saved values unchanged. Re-read and reconcile the draft; do not blindly retry a replacement. Synchronous commit and plugin revocation are serialized. These methods remain experimental; existing stable core contracts are unchanged.

Schema changes never silently remove or reinterpret stored values. Reads return old values with `schemaChanged: true`. A plugin can explicitly migrate to the current schema using a revision-checked replacement. The host form shows the original values and asks before preparing a draft that retains compatible fields. Data changes only when Save succeeds. A failed save retains the draft. Reload asks before discarding unsaved changes.

Each value map is limited to 32 KiB of serialized UTF-8 JSON, with 4 MiB per plugin and 32 MiB total. Retained documents are limited to 2048 per plugin and 16384 total, including empty documents. Field metadata is included in the application database and its normal migration/backup lifecycle. Stopping, revoking or uninstalling a plugin preserves saved values; reinstalling the same ID can recover them after normal approval. Removing a host deletes its field documents. Uninstall does not free this quota; use an empty replacement to clear values before uninstall, or remove the host to delete its documents. IDs therefore form a persistent namespace, not a secret boundary against a newly approved replacement package with the same ID.

Successful writes emit advisory native `hosts://fields-changed` notifications with `{pluginId, hostId, revision}` and an operation audit record containing no values. Notifications can be missed; revisions remain authoritative. The host form refreshes clean drafts and retains edited drafts on external changes. This native notification is not a new plugin subscription API. Typed table columns are described in [host columns](host-columns.md). Host source providers and connection ownership are separate extension capabilities.

See [UI providers](ui-providers.md) and [plugin development](README.md).
