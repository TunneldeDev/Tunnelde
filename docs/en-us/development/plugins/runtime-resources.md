# Runtime resource lifecycle

`resources.snapshot`, `resources.identify` and `resources.release` are **experimental**. They provide a bounded view of resources owned by the calling plugin's approved, current runtime. They do not introduce a second registration table or grant access to another plugin. Existing domain registries remain authoritative.

| Method               | Request                                | Result                                 |
| -------------------- | -------------------------------------- | -------------------------------------- |
| `resources.snapshot` | `{offset?: number, revision?: string}` | `{revision, items, total, nextOffset}` |
| `resources.identify` | `{kind, id}`                           | `{handle, kind, state}`                |
| `resources.release`  | `{handle: string}`                     | `{handle, outcome}`                    |

Each item contains only `handle`, `kind` and `state`. Kinds are `connection`, `forward`, `mount`, `task` and `transfer`; states are `owned`, `releaseRequested` and `cleanupRequired`. Paths, commands, credentials and global internal stores are not returned. Handles bind the plugin identifier, package fingerprint, runtime generation, kind and exact domain instance. They identify resources; they are never authorization credentials.

Only committed, active domain resources appear. Connections additionally require accepted ownership. Pending connection results, manually created or explicitly handed-off connections, other runtimes and completed task/transfer history are excluded. A paused transfer stays owned; requesting cancellation supersedes pause. Reusing a transfer ID creates a different instance and invalidates the old handle.

Pages contain at most 128 items and 64 KiB. The observation limit is 4,096 resources. Continue with `nextOffset` and the exact returned revision. On `plugin.resources.changed`, discard the accumulated pages and restart at offset zero. The revision covers handles and lifecycle states, not task output or transfer progress. This is a bounded observation across registries, not an atomic global transaction, retained snapshot or event subscription.

Releasing rechecks the current approval and exact domain ownership at the final action. Old handles cannot close a replacement listener or transfer, a handed-off connection or another runtime's resource. Resources with a tool-client lifetime also recheck that client. `released` means the owned connection transport and terminal worker, forwarding listener cleanup, or normal mount/process cleanup has completed. Dependent resources retain their own lifecycle and may still be cleaning up. `cancellationRequested` means a process task or transfer received cooperative cancellation; it remains active and consumes its existing domain quota until its worker settles. No forced unmount, history deletion, recovery-file deletion or rollback of remote commands is implied.

Observations have a 5-second deadline. At most 4 observations/disposals per plugin and 16 globally can be in flight. Once disposal is submitted, losing the caller does not cancel cleanup or release its operation capacity early. Errors retain their domain category; lifecycle validation adds `invalidRequest`, `changed`, `unavailable`, `observationLimit`, `busy`, `workerFailed` and `cleanupIncomplete` under `plugin.resources`. Unsupported methods must be detected with `api.describe` on older hosts.

The SDK's `sdk/runtime/resources/client.mjs` facade has strict signatures without the legacy dynamic overload. It uses the existing approved transport and does not start Node. Trusted UI plugins can call the same methods through `context.api.call`; their local `UiResourceScope` is separate. Durable runners, recovery records, UI scopes and general dependency activation are not covered by this catalogue.

Implementation is organized by domain and responsibility: `plugins/runtime/ownership/` owns reservations; `runtime/lifecycle/contracts/` owns wire DTOs; `adapters/` bridges each domain; `projection.rs`, `admission.rs` and `rpc.rs` handle paging, operation budgets and transport coordination. Domain lifecycle helpers stay beside their authoritative registries. Public TypeScript contracts live under `contracts/runtime/lifecycle/`; SDK DTOs, method maps, facade contracts and implementation are separated and checked during SDK synchronization. The existing protocol version and stable APIs are unchanged.

## Identify a resource explicitly

`resources.identify({kind, id})` returns the same `{handle, kind, state}` item for one
current, committed resource owned by this runtime. `id` is the existing domain ID:
`sessionId` for `connection`, forwarding rule ID for `forward`, `mountId` for `mount`,
`taskId` for `task`, and transfer ID for `transfer`. Do not infer ownership by comparing
snapshots before and after concurrent creation. The selector rejects extra properties;
`id` must be nonempty, at most 512 UTF-8 bytes, without control characters.

Missing, foreign, retired, pending-result and handed-off resources all return
`plugin.resources.unavailable`. Identification grants no permission and registers
nothing. It queries only the selected domain using the existing observation budget;
an unrelated mount operation does not block a connection query. The result identifies
the instance current at observation, not necessarily the result of an earlier create.
Retain that exact handle: a subsequent replacement or handoff prevents its release
from touching the new owner or instance. Snapshot shapes remain unchanged.

Discover the method with `api.describe`; newer extension catalogues also expose optional
`runtime.resources.identify`. Older hosts may omit it. The strict SDK facade provides
`createRuntimeResourcesClient(host).identify({kind, id})`.

## Compose with a view lifetime

Register cleanup only for an explicitly selected resource that this view should own.
For example, given a saved `sessionId` belonging exclusively to this view:

```jsx
function ConnectionView({ resources, sessionId }) {
  const { useEffect } = context.sdk.react;
  useEffect(() => {
    const lifetime = resources?.child?.();
    if (!lifetime) return;
    void lifetime
      .acquire(
        () => context.api.call("resources.identify", { kind: "connection", id: sessionId }),
        async (resource) => {
          await context.api.call("resources.release", { handle: resource.handle });
        },
      )
      .catch((error) => {
        if (!lifetime.signal.aborted) console.error(error);
      });
    return () => lifetime.dispose();
  }, [resources, sessionId]);
  return null;
}
```

The child handles effect replay and changed dependencies. Hidden retained views stay
live; closing the view starts its registered cleanup, including cleanup of a late
identification result. Releasing a native resource still rechecks its exact ownership;
cleanup errors remain diagnostic and must not be presented as successful disposal.
Do not register unrelated resources or durable runners for view cleanup. Closing a
view never implicitly stops a runner or deletes its recovery record. Module retirement
may already deny `context.api` calls; the existing host-owned runtime retirement then
remains responsible for native resource cleanup. The UI scope is neither a permission
bypass nor a transport that survives module retirement.
