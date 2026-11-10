# Public preferences

[简体中文](plugin-preferences.zh-cn.md)

`preferences.schema`, `preferences.snapshot` and `preferences.update` are
experimental API v1 methods. Reads require `settings.read`; writes require
`settings.write`, in addition to the ordinary plugin approval and lifecycle checks.
They do not require trusted frontend code. `settings.get/update` retain their
existing compatibility behavior and internal field names.

## Structure and ownership

The new contract has eleven groups: `general`, `appearance`, `workspace`,
`terminal`, `files`, `transfers`, `editor`, `monitoring`, `shortcuts`, `network`
and `updates`. Discover exact field names, enums and limits with
`preferences.schema`. Snapshot results contain `version: 1`, an opaque `revision`,
detached `values`, and the current platform's `defaults` in these same groups.
Group names and public fields are explicitly mapped; internal storage is not the
wire contract. Do not derive public types from the application's `Settings` type.

Provider selection, update-check timestamps, skipped releases, credentials and
storage migration are excluded. Network profiles contain proxy identities and
usernames but never passwords; this API grants no keychain access. Schema bounds
describe structure, while host semantics also check proxy references, shortcuts,
theme identities and update-source configuration. Character limits count Unicode
scalar values; `x-maxBytes` is an additional UTF-8 byte limit.

## Updating a snapshot

```ts
const before = await host.call("preferences.snapshot", {});
const after = await host.call("preferences.update", {
  revision: before.revision,
  changes: {
    appearance: { theme: "dark" },
    terminal: { copyOnSelect: true },
  },
});
```

Only supplied fields change. **Each supplied field replaces its entire value**;
this includes nested maps, arrays and objects. For example, `appearance.colors: {}`
clears all regional overrides. To change one column width, send the complete
`workspace.hostList` field from the latest snapshot with that width changed.
Unknown fields, wrong types and invalid values fail without silent truncation,
clamping or normalization. `preferences.invalidValue:<public-field-path>` identifies
the field without echoing arbitrary values, map keys or credentials.

All native, legacy and new preference writers, including update-check metadata,
share one serialized commit boundary. Every successful save atomically rotates a
persistent UUID revision with the settings, even if values do not change. A stale
revision returns `preferences.staleRevision` before side effects or persistence;
read again and explicitly reconcile the intended change. Do not automatically
overwrite a new snapshot. Reverting a value does not revive an older revision.
Read-only access to an older database does not create a revision record; its first
successful settings save creates one. Revisions survive application restarts.

Authorization is checked again after waiting for another writer and immediately
before persistence. Database failure preserves the settings and revision; prepared
title-bar changes are restored. Post-commit notifications and external cleanup
are outside the database transaction. These methods do not promise rollback of
external effects, plugin-defined schemas, migrations or a replaceable settings UI.

## Contract maintenance

Host services live under `services/settings/preferences/`, separating `contracts`,
`mapping`, `schema`, `projection` and `update`. Each group owns a JSON schema and
mapping. RPC adapters and method discovery live under their respective
`settings/preferences` directories; they do not contain preference business rules.

Run `node scripts/contracts/preferences/generate.mjs` after changing a schema.
`--check` verifies the generated independent types under
`src/lib/preferences/contracts/`; CI runs this check. Marketplace SDK synchronization
mirrors those public declarations into `sdk/rpc/settings/preferences/` and schemas
into `sdk/preferences/schema.json`. Its check mode verifies host/SDK parity without
writing files. Historical RPC consumer tests remain separate from these new types.
