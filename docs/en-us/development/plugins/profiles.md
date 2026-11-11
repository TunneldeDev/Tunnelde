# Profile metadata observation

`profiles.observe` is experimental and requires `settings.read` plus the calling
plugin's current approval and runtime authorization. Detect support with
`api.describe`; older hosts may omit it. The protocol version remains 1.

Call with `{}` for the initial state or `{revision}` for a conditional read.
Revision tokens are opaque, 1–128 UTF-8 bytes without control characters. Explicit
null, empty tokens and extra request fields are rejected. The response is either:

```json
{ "version": 1, "revision": "opaque", "changed": false }
```

or `changed:true` with `snapshot:{version:1,revision,items}`. Both revision fields
match. Items retain native list order and contain only `id`, `name` and `updatedAt`
(Unix milliseconds). There are at most 32 items and 32 KiB of encoded response.
IDs are nonempty, at most 128 UTF-8 bytes, without control characters; names use
the native trimmed, unique, case-insensitive 64-character contract. Timestamps are
nonnegative safe integers. No saved settings, proxy passwords, provider selection,
storage paths, database keys or profile-activation authority are returned.

The read uses a consistent SQLite transaction. Native profile saves/deletes persist
their list and a new UUID generation together; a failed commit preserves both.
Reopening the database preserves the revision. Older databases are observed without
writing a new token. A metadata digest also detects visible list changes from
historical writers that do not update the generation. Private preference contents
do not enter that digest. A current native save may invalidate the revision even
when visible metadata is unchanged. This is latest-state observation, not an event
cursor or a promise to deliver every intermediate commit.

Stored input and metadata decoding are bounded before projection. Corrupt,
duplicate, oversized or invalid metadata returns `profiles.invalidStorage`, without
echoing stored values. No silent rewrite or repair follows. An oversized native
save returns `profiles.storageTooLarge` and retains existing data. Read authorization
is checked before database work and again before encoding the result.

## SDK lifecycle

```js
import { createProfilesClient } from "./sdk/profiles/client.mjs";

const profiles = createProfilesClient(host);
const subscription = profiles.subscribe(
  async (snapshot) => {
    updateProfileNames(snapshot.items);
  },
  { signal: viewLifetime.signal },
);

const result = await subscription.done;
if (result.reason === "failed") reportFailure(result.error);
```

The strict facade provides `observe(request?, {signal?,timeoutMs?})` and `subscribe`.
Distribute `sdk/profiles/`, `sdk/runtime/observation/` and referenced declarations.
No Node globals or runtime installation are required. Use an explicitly authorized
transport that supports cancellation/deadlines; basic trusted-UI `api.call` alone
does not provide that transport contract.

Subscriptions require an owner AbortSignal, allow eight per client and use serial
reads/callbacks. The 1000–60000 ms interval (default 2000) starts after each read and
async callback settle; reads have a 10000 ms deadline. Initial metadata is delivered
once, then only changed revisions. Returned metadata is detached and deeply frozen.
Stop/abort fences late delivery. `closed` means delivery stopped; `done` waits for
settlement and resolves stopped/aborted/failed. Cancelled unsettled work retains its
quota. Errors stop without retries. A transport ignoring cancellation/deadlines can
delay settlement. Work started by callbacks needs its own lifetime.

DTOs live under `contracts/profiles/data/` and are mirrored into SDK RPC/UI modules.
The machine schema is mirrored to `sdk/profiles/schema.json`. Structural schema
validation is supplemented by UTF-8 byte limits, unique IDs/names, trimmed names,
revision pairing and output-size checks in the host/consumer. CI checks actual Rust
producer output against the schema and selected SDK consumer, plus catalogue/type
parity and historical consumers.

This does not add profile content editing, activation, file import/export or durable
subscriptions. Those need independent governance contracts; existing native profile
controls and stable preference/editor APIs remain compatible.
