# Host storage locations

These experimental methods manage global storage location metadata. They are separate from [plugin-owned JSON storage](storage-observation.md), settings, and keyring secrets. Detect support with `api.describe`; declaring a permission does not grant file access.

| Method                       | Required permissions               | Behavior                                                                   |
| ---------------------------- | ---------------------------------- | -------------------------------------------------------------------------- |
| `storage.locations.observe`  | `storage.locations.read`           | Conditional metadata read; no recursive inventory scans                    |
| `storage.locations.schedule` | Read and `storage.locations.write` | Review normalized destinations and schedule migration for the next restart |
| `storage.locations.cancel`   | Read and write                     | Review and cancel an unstarted plan; never delete recovery artifacts       |

`observe({})` returns `{version:1, revision, changed:true, snapshot}`. A matching opaque revision returns `changed:false` with no snapshot. The snapshot contains eight ordered categories: `database`, `plugins`, `pluginData`, `keys`, `runtimes`, `cache`, `logs`, `runners`. Each has `path`, `defaultPath`, and `overridden` (the environment-forced plugins directory). `pending` is null or `{changes:[{category,target,migrate}]}`; `recoveryRequired` indicates a previous error or an existing staging, publication marker, or recovery journal. Raw errors, recovery IDs, inventory and contents are not exposed. Bounded marker metadata checks are allowed; subscriptions do not scan directory contents.

Use `createHostStorageClient(host)` from `sdk/storage/locations/client.mjs`. Its `subscribe` requires an owner `AbortSignal`; up to eight subscriptions per client serialize reads and callbacks, with a 1–60 second interval and a ten second read deadline. Changes may coalesce; this is not an audit log. It does not use the plugin KV client's permissions or storage.

```js
const current = await client.observe();
const result = await client.schedule(
  {
    revision: current.revision,
    changes: [{ category: "cache", target: "/absolute/new-cache", migrate: true }],
  },
  { signal: owner.signal },
);
// result.outcome is scheduled or dismissed; inspect result.snapshot.
```

Scheduling accepts one to eight distinct categories. Paths are absolute UTF-8, at most 4096 bytes without control characters; revisions are 1–128 UTF-8 bytes without controls. Null and unknown request fields are rejected. Existing path, overlap, target and capacity validation applies. The native dialog identifies the plugin and shows category, source, normalized destination, copy behavior, and restart timing. It expires after 55 seconds and never replaces another dialog. The SDK uses a 70 second mutation deadline by default. The final write revalidates destinations and revision; concurrent native edits fail with `storage.locations.conflict`.

Cancellation of an unstarted plan uses its exact revision. A recovering plan returns `storage.locations.recoveryRequired` and is preserved for native recovery. Successful mutations return `{version:1,outcome:"scheduled"|"cancelled",snapshot}`; declining returns `dismissed` with a fresh snapshot. Scheduling shows the normal restart prompt but never restarts or migrates automatically. A cancelled request before the publication fence cannot publish configuration; cancellation after publication does not roll it back. Read the latest state after a lost reply. Temporary metadata is synced outside the policy fence and cleaned up on rejection. There are four outstanding native operations, including unfinished blocking workers and pending confirmations; excess work fails with `plugin.api.busy`.

The machine schema is in `src-tauri/src/plugins/api/domains/storage/locations/schema.json`; public DTOs are classified under `contracts/storage/locations/` and mirrored to the SDK with drift checks. Snapshots are at most 127 KiB; responses and persisted configuration at most 128 KiB. Schema, native producer and actual SDK consumer are checked together. These guarantees cover plan metadata, not the safety of all migration recovery, file mutation, or cross-volume operations. The API remains experimental.

The publication fence fails with `storage.locations.busy` instead of holding plugin policy while waiting for native inventory work; read the latest state and retry.
