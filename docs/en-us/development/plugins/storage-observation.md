# Plugin-owned storage observation

`storage.observe` is experimental. Discover it with `api.describe`; protocol v 1
and the existing stable `storage.get/set/delete` contracts are unchanged. It needs
current plugin approval/runtime authorization, with no additional domain permission.
It reads only the calling plugin's JSON KV map. It accepts no plugin ID, path,
keyring selector, host storage-location or migration authority.

Call with `{}` initially or `{revision}` conditionally. Revisions are opaque,
1–128 UTF-8 bytes without controls. Null, empty tokens and extra fields fail with
`plugin.api.invalid:params`. A matching revision returns
`{version:1,revision,changed:false}` without a snapshot. Otherwise it returns
`{version:1,revision,changed:true,snapshot:{version:1,revision,values}}`;
the two revision fields match. Missing keys differ from keys containing JSON null.

Reads reuse the stable repository lock and historical file format. They never
create missing files, rewrite legacy data or repair corruption. Revisions bind
plugin identity and recursively sorted JSON object keys; array order matters.
This is latest-state polling: identical writes and A→B→A between reads may
coalesce. It is not an event cursor, write count or durable subscription.

The host bounds stored bytes and the encoded map to 256 KiB, and the response to 257 KiB.
JSON has depth at most 64 from the root values object, finite numbers and safe
integral numbers (±9007199254740991). Top-level keys have 1–128 ASCII letters,
digits, dots, hyphens or underscores, excluding `__proto__`, `constructor` and
`prototype`. Nested object keys are ordinary JSON strings, including Unicode and
control characters. Strings use valid Unicode. Invalid legacy data returns
redacted `plugin.api.invalidStorage` or `plugin.api.storageTooLarge`, without
including stored values. These restrictions apply to the new observation surface;
the historical stable read/write contract remains compatible. Authorization is
checked before storage I/O and before returning the observation.

## SDK lifecycle

```js
import { createStorageClient } from "./sdk/storage/client.mjs";
const storage = createStorageClient(host);
const subscription = storage.subscribe(async (snapshot) => renderDraft(snapshot.values.draft), {
  signal: viewLifetime.signal,
});
const result = await subscription.done;
if (result.reason === "failed") reportFailure(result.error);
```

Distribute `sdk/storage/`, `sdk/runtime/observation/` and referenced declarations.
The facade needs an explicitly authorized transport supporting cancellation and
deadlines. It installs no runtime and uses no Node globals. A trusted-UI `api.call`
alone does not supply that transport contract. Public results are detached and
deeply frozen; nested prototype-like keys remain safe data properties.

Subscriptions require an owner AbortSignal. At most 8 belong to one client.
Reads/callbacks run serially; the 1–60 s interval (default 2 s) begins after settlement,
with a 10 s read deadline. Initial state and changed snapshots are delivered.
Stop/abort fences late delivery; `closed` stops delivery, while `done` waits for
settlement and resolves stopped/aborted/failed. Unsettled cancelled work retains
quota. Errors terminate without retry. A transport ignoring cancellation/deadlines
can delay settlement; callback-owned work needs its own lifetime.

Rust and ECMAScript can encode the same decoded small number differently
(`1e-6` vs `0.000001`). The SDK therefore uses a separate 512 KiB decoded JSON work
budget; it does not infer original wire size from JavaScript reserialization.
Native wire limits stay 256/257 KiB. Actual native maximum-size, decimal and Unicode
fixtures pass through both the structural schema and real SDK consumer in CI.
DTOs and schemas are generated from independent host contracts; historical SDK
fixtures remain frozen. Host storage locations/migration and application log
subscriptions need separate contracts and are not provided by this method.
