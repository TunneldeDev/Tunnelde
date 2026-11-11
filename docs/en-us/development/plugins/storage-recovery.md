# Host storage recovery

`storage.recovery.observe` and `storage.recovery.request` are experimental API v1
methods. Discover support with `api.describe` before calling them. They are separate
from plugin key/value storage and unstarted location plans.

Request `storage.recovery.read` to observe metadata and additionally
`storage.recovery.write` to request recovery. The host always identifies the plugin
and asks the user to confirm a recovery request, even when the plugin is approved.

```js
import { createHostStorageRecoveryClient } from "./sdk/storage/recovery/client.mjs";
const recovery = createHostStorageRecoveryClient(host);
const observation = await recovery.observe();
if (observation.changed && observation.snapshot.pending) {
  const result = await recovery.request(
    { revision: observation.revision, action: "retry" },
    { signal: owner.signal },
  );
  // restartScheduled records intent only. The user chooses when to restart.
}
```

The independent snapshot includes `version: 1`, an opaque `revision`, eight ordered
current/default `locations`, `pending` or null, `recordedCopies`, and `hasError`.
Pending metadata contains `action: apply | cancel`, `restartRequested`, and exact
normalized `changes`. Copies are ordered by category then `previous`/`archive`, with
at most one recorded path per kind/category. Neither raw errors nor private plan
identifiers, secrets or contents are returned. A recorded path does not prove
existence, integrity, exclusive ownership, completeness of history or permission to
delete anything. Reads never inventory or probe these recorded copies.

`request({revision, action: "retry" | "cancel"})` requires an exact pending plan.
Retry preserves its existing direction, including cancellation. Cancel irreversibly
sets that direction to cancellation. Confirmation expires after 55 seconds; the SDK
uses a 70-second default transport timeout. After confirmation, the native service
rechecks the revision, live runtime generation/permissions and cancellation fence
before replacing bounded, synced configuration metadata. No migration I/O runs while
the plugin policy fence is held. Successful requests return
`{version:1, outcome:"restartScheduled", snapshot}`; denial returns `dismissed` with
the latest snapshot. There is no automatic restart or artifact deletion.

The next startup consumes `restartRequested` before migration I/O and before the
database, plugins or other writers start. Settings distinguishes scheduled recovery
from failed execution and retains the previous error until successful recovery.
An interrupted execution keeps the plan and direction. Repeating an unchanged exact
request only resaves metadata. After a timeout/lost reply, observe the authoritative
state rather than automatically retrying a possibly committed write.

`observe({revision?})` omits its snapshot when unchanged. Revisions include private
configuration identity and public projection but convey no filesystem authority.
The SDK's `subscribe(callback,{signal,intervalMs?})` serially polls latest state,
coalesces revisions and stops with its owner. It is not a per-write event log.

Strict requests reject extra fields/null revisions. Revisions use 1–128 UTF-8 bytes;
absolute UTF-8 paths use at most 4096 bytes without control characters. Snapshots are
at most 127 KiB and responses 128 KiB. Use the machine schema in
`src-tauri/src/plugins/api/domains/storage/recovery/schema.json` and the mirrored SDK
types. Treat `storage.recovery.conflict` as a request to refresh and confirm again;
`noPendingPlan`, `busy`, `invalidState` and `unavailable` are explicit failures.

This interface does not provide exclusive cross-process parent-directory authority,
physical power-loss/media-failure guarantees, downgrade recovery, automatic orphan
cleanup or a complete archive inventory. Keep external backups. The location APIs
and their existing snapshots remain unchanged; `storage.locations.cancel` still
rejects recovery artifacts instead of deleting them.
