# Persisted log reading

`logs.read` is experimental and separate from the stable `log` writer. Detect it with
`api.describe` before use. An approved running plugin needs the independent `logs.read`
permission. This grant covers application diagnostics, operation history and other plugins'
records; free-form messages may contain sensitive information. The writing permission alone
does not grant reading. Runtime revocation and restricted mode remain effective.

```js
import { createLoggingClient } from "./sdk/logging/client.mjs";

const logs = createLoggingClient(host);
const owner = new AbortController();
const subscription = logs.subscribe(
  async (page) => {
    if (page.gap) showIncompleteHistory();
    await appendEntries(page.entries);
  },
  { signal: owner.signal, intervalMs: 2000 },
  { source: "diagnostics", filter: { levels: ["warn", "error"] } },
);
// Dispose with the owning view/runtime. done resolves after pending work settles.
owner.abort();
await subscription.done;
```

Use `{ call: (...args) => context.api.call(...args) }` as the host adapter in a trusted
frontend plugin. This SDK adds no Node dependency to the frontend runtime.

## Query and projection

`source` is `diagnostics` (default) or `operations`. `limit` is 1–200, default 100.
`filter.domains`, `filter.plugins` and `filter.levels` match exact values: OR within each
field, AND between fields. Omitted/empty arrays mean unrestricted. Domain identifiers allow
ASCII letters, digits, `.`, `_`, `-`, `:` (1–256 bytes, at most 16 values); plugin identifiers
use the same alphabet (1–128 bytes, at most 16 values). Levels are lowercase `trace`, `debug`,
`info`, `warn`, `error`, at most five values. Duplicates are invalid. `text` is case-insensitive
plain text over the projected message/domain/plugin/fields, at most 256 UTF-8 bytes without
control characters. Null selectors and unknown request/filter fields are rejected.

The independent DTO contains `timestamp`, `level`, `domain`, `pluginId`, `message`, `fields`
and `truncated`. Missing/invalid timestamps become null. Structured fields reuse writer
credential-key and HTTP/SOCKS URL sanitization; arbitrary message text and URL paths cannot
be reliably scrubbed. Messages are bounded to 16 KiB, each encoded entry to 64 KiB, and a page
to 128 KiB. Malformed/oversized records are skipped with `gap`; oversized projected text or
fields use `truncated`. No raw JSONL lines, selected log filename, cursor path, terminal bytes
or internal store shapes are returned. Message/context metadata may include paths and remains
sensitive. Operation history projects fixed actions and opaque target IDs, with null
plugin identity unless the action records a plugin target.

## Cursor and lifetime

Each page has `{version:1,source,entries,cursor,hasMore,reset,gap}`. Pass its cursor on the
next read with the same source and filter. Cursors are opaque bounded position records,
bound to process, plugin fingerprint/runtime generation and normalized query. Changing
source/filter/owner or restarting requires a fresh read. They do not select paths or confer
authority. A modified position is not a security bypass; `logs.read` authorization is always
required. File handles reject selected symlinks/reparse points and nonregular files.

On an initial diagnostic read, only the current host-selected daily log is considered,
starting within its latest 256 KiB; older bytes set `gap`. Subsequent reads scan at most
256 KiB/2048 records and preserve the first matching entry that did not fit in the page.
Incomplete tails wait for an append; overlong lines are discarded incrementally. File
identity and the 64 bytes preceding the position detect ordinary replacement/truncation;
these are best-effort append-log checks, not a snapshot or proof against arbitrary in-place
rewrites. Rotation, missing current file or invalidated positions report `reset` and `gap`.
The reader does not drain retired files. Operation reads use the most recent 1000 retained
records with ID positions and report missing retention/positions. No durable delivery or
complete historical audit is promised; the existing nonblocking writer may also drop records.

Drain `hasMore` pages serially. The SDK yields between pages, waits for each callback,
limits draining to 32 pages before the next polling interval, and uses 10-second call
deadlines. Up to eight subscriptions per client are allowed, with an owner AbortSignal and
an integer 1–60 second interval. Cancellation suppresses late delivery; pending reads and
callbacks retain capacity until settlement. Stop/abort results resolve `done`; a transport,
validation or callback error terminates it with `{reason:"failed",error}`. It does not silently
restart with a lost cursor. Native blocking workers have an independent four-worker limit;
abandoned workers remain charged until exit, with authorization checked outside policy/DB
locks before and after I/O. Callers may see `plugin.api.busy` during contention.

Public errors include `logs.read.invalidRequest`, `logs.read.invalidCursor`,
`logs.read.unavailable`, shared authorization/cancellation errors and `plugin.api.busy`.
Unavailable errors hide filesystem/DB details; inspect the application's local logs for
broader diagnostics. Handle unknown errors and feature-detect experimental support.

The machine schema is at `src-tauri/src/plugins/api/domains/logging/schema.json`; independent
TypeScript DTOs are under `src/lib/extensions/contracts/logging/`. SDK synchronization checks
both and CI consumes a page emitted by the actual Rust reader. The native Output panel IPC
and frozen stable writer contracts remain separate. See [user logging guide](../../guide/logging.md).
