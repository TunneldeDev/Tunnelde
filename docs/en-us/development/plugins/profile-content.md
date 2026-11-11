# Public profile contents

The experimental `profiles.catalogue` and `profiles.read` methods require
`settings.read`, current plugin approval and runtime authorization. Detect support
with `api.describe`. They do not grant write or activation authority.

`profiles.catalogue({})` returns `{version:1,revision,activeId,items}`. Items retain
the native metadata order and 32-item limit. The opaque full-content revision is
separate from the historical metadata-only `profiles.observe` token: do not
interchange them. It detects body changes by old writers and same-content saves
by current writers. `activeId` records the last explicit native selection; it does
not imply equality with current preferences. Selection alone does not change the
content revision.

`profiles.read({id,revision,offset,limit})` returns
`{version:1,id,revision,offset,totalBytes,text,nextOffset}`. Offsets/limits count
UTF-8 bytes; `limit` is 4–65536 and the starting offset must be a character
boundary. Follow `nextOffset` until null, then parse the concatenated text as JSON.
The result has the 11 public `PreferenceValues` groups and their schemas. It omits
private provider selections, runtime metadata, credentials and native storage keys.
Do not interpret it as a native Settings document.

Escaping may shorten a segment so its encoded response stays within 128 KiB.
Each body is limited to 16515072 bytes. Existing native collection and import-file
limits remain unchanged; a large native saved body is not narrowed to the import
limit. Invalid legacy content returns `profiles.content.invalidContent`, without
silent repair. Malformed requests/ranges, absent IDs and changed collections return
`profiles.content.invalidRequest`, `profiles.content.invalidRange`,
`profiles.notFound` and `profiles.conflict`. A conflict requires a fresh catalogue
and an explicit new read; never join segments from different revisions.

Up to four background workers retain capacity until settlement, including after
cancellation. Each page rechecks current grants before/after work. Projection
does not hold the database lock; immutable projections may be cached for 30 seconds,
four entries and 32 MiB. Cache hits still validate the current repository revision
and authorization. No session, filesystem or plugin runtime is started by a read.

The SDK automatically assembles and validates public values:

```js
import { createProfilesClient } from "./sdk/profiles/client.mjs";

const profiles = createProfilesClient(host);
const catalogue = await profiles.catalogue({ signal: viewLifetime.signal });
const item = catalogue.items[0];
if (item) {
  const values = await profiles.read(
    { id: item.id, revision: catalogue.revision },
    { signal: viewLifetime.signal, timeoutMs: 30000 },
  );
  showTheme(values.appearance.theme);
}
```

Use a transport that honors cancellation/deadlines; plain trusted-UI `api.call`
alone does not guarantee this. Distribute the referenced generated preferences schema module,
profiles modules, runtime observation modules and declarations with the facade.
No Node globals or user Node runtime are required. Results are detached and deeply
frozen. Reads require an owner AbortSignal and a single total deadline (default
30 seconds, configurable 1–120000 ms), at most four unsettled operations per client
and 4096 pages. Cancellation suppresses late results; ignored transport cancellation
delays settlement and retains capacity. Errors stop without automatic retry.

Independent DTOs and the machine schema are mirrored to the SDK. CI validates
actual Rust-produced large Unicode/escaped content against the schema and SDK,
in addition to frozen metadata and stable-core consumers. These methods remain
experimental. Draft writes, atomic public CRUD and confirmed activation are separate
work; existing native controls and `profiles.observe` retain their contracts.
