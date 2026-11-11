# Plugin configuration

The optional manifest `configuration` contribution provides plugin-owned settings. Users can edit them under **Settings → Plugins → Plugin configuration** without starting or approving plugin code. Groups are collapsed until opened. Both settings searches support `@plugin:identifier`, `@group:general` and `@id:field`, with filter presets in the funnel menu. Changes require **Save**. Conflicts keep the draft and require review; they are never retried automatically.

Configuration is application-wide per plugin identifier, stored inside the relocatable **Plugin data** category. Uninstalling preserves it. Application preference Profiles and the stable `storage.*` key/value API retain their existing behavior. Credentials belong in `secrets.*`, not configuration defaults or values.

## Manifest and schema

```json
{
  "configuration": {
    "version": 1,
    "groups": [{ "id": "general", "title": "General" }],
    "fields": [
      {
        "id": "enabled",
        "group": "general",
        "title": "Enabled",
        "schema": { "type": "boolean" },
        "default": false
      },
      {
        "id": "limit",
        "group": "general",
        "title": "Result limit",
        "schema": { "type": "integer", "minimum": 1, "maximum": 100 },
        "default": 20
      }
    ]
  }
}
```

This is a closed JSON Schema subset. Every unknown keyword is rejected. Supported shapes:

| Type                | Required keywords                                               | Optional keywords          |
| ------------------- | --------------------------------------------------------------- | -------------------------- |
| `boolean`           | `type`                                                          | —                          |
| `string`            | `type`, `maxLength`                                             | `minLength`, string `enum` |
| `number`, `integer` | `type`, `minimum`, `maximum`                                    | —                          |
| `array`             | `type`, `items`, `maxItems`                                     | —                          |
| `object`            | `type`, `properties`, `required`, `additionalProperties: false` | —                          |

No references, external schemas, executable validators or coercion are supported. String lengths count Unicode code points. Integers and integer bounds must be safe JavaScript integers. Every top-level field needs a valid default and must be present in a saved document; unknown fields are rejected. Nested objects can have optional declared properties. Scalar fields use native controls; arrays and objects use a validated JSON editor. Metadata is plain text, not markup.

Limits: 16 groups, 64 fields, 64 KiB declaration, 64 KiB values, nesting depth 8 and 512 schema nodes. Strings allow at most 16,384 code points, arrays 256 items and enums 128 choices. The database allows 4,096 plugin documents and 64 MiB serialized values including backups. A full backup allocation blocks migrations/restoration until a user or owning plugin explicitly deletes a backup.

## Owned API and concurrency

All `configuration.*` methods are **experimental** and discoverable through `api.describe` and the `plugin.configuration` extension point. They require an approved, current executable runtime, but no global settings permission. Identity comes from that runtime; no method accepts a target plugin identifier. Native settings editing uses inert installed metadata and does not grant execution permission.

| Method                       | Request                                      | Result                                         |
| ---------------------------- | -------------------------------------------- | ---------------------------------------------- |
| `configuration.schema`       | `{}`                                         | Manifest configuration declaration             |
| `configuration.snapshot`     | `{}`                                         | Declaration, digests, status, values, revision |
| `configuration.update`       | `{expectedRevision, schemaDigest, values}`   | New snapshot                                   |
| `configuration.migrate`      | `{expectedRevision, schemaDigest}`           | Migrated snapshot                              |
| `configuration.backups`      | `{}`                                         | Up to 8 owned backups, including values        |
| `configuration.restore`      | `{expectedRevision, schemaDigest, backupId}` | Restored snapshot                              |
| `configuration.deleteBackup` | `{expectedRevision, schemaDigest, backupId}` | `null`                                         |

Read operations never create defaults on disk or migrate data. Revision is `initial` before the first save and a new UUID on every successful replacement, migration or restoration. Include both the revision and current schema digest in mutations. Equal values do not make an old revision valid again. A schema mismatch blocks ordinary updates even when new values would validate.

Use the SDK's separate `sdk/configuration/client.mjs` facade for strict method signatures without the legacy `host.call` dynamic overload. Check discovery before using it on older hosts. Existing calls and protocol `apiVersion: 1` remain unchanged. Invalid values report `configuration.invalidValue:<field path>`; stale revisions report `configuration.conflict`; schema drift, missing migrations, invalid migration operations and backup limits have separate localized errors. IO/database failures retain their original error category.

## Explicit upgrades and recovery

`snapshot.status` is `ready`, `migrationRequired` or `incompatible`. The snapshot retains the stored values and version when a migration is needed. Downgrades and changes to the data schema at the same version are incompatible. Metadata edits and field reordering do not change the data digest.

Declare up to 32 migrations, each with `fromVersion`, exact `fromDigest`, strictly larger `toVersion`, exact `toDigest`, and up to 128 operations. Obtain data digests from snapshots of the source/target declarations; digests exclude labels, groups, ordering and migration history. Supported operations are top-level `rename {from,to}`, `setDefault {key,value}` and `remove {key}`. Rename refuses a missing source or existing target. Set-default never overwrites an existing value. Remove refuses a missing field. Every step must form an exact version/digest chain, and the final values must satisfy the entire target schema.

Migration only occurs after an explicit native confirmation or owning-plugin API call. The old document and the new document commit in one SQLite transaction. A failure rolls back both. No plugin code, shell commands or plugin SQL execute during migration. Restoration first retains the current document and then creates a fresh revision; restoring an old schema may require migration again. Backups are never silently evicted. Their values can be inspected in the settings disclosure before explicit deletion. Configuration values are neither logged nor included in invalidation events.

## Implementation boundaries

Native code lives in `services/plugin_configuration/`: public `contracts/`, separate schema definition/value validation, transaction repository and data migration, with transport adapters under `plugins/configuration/`. Frontend contracts live in `lib/extensions/contracts/configuration/`; form components, draft runtime and search/value helpers live separately under `features/plugins/configuration/`. The Hub mirrors these public contracts into domain SDK directories and checks them against the selected host. These additions do not declare the full plugin architecture or experimental APIs stable.
