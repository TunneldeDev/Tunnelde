# Host file-preview observation and presentation

[简体中文](../../../zh-cn/development/plugins/file-preview.md) · [File resources](../file-resources.md)

The experimental `filePreview` domain exposes the host's current Quick Look or
docked preview. It does not represent every editor, a filesystem snapshot or a
public renderer URL. Check `api.describe` and `extensions.describe`
before using it. The stable core and protocol version remain unchanged.

| Method                  | Required permission                                             | Result                                                   |
| ----------------------- | --------------------------------------------------------------- | -------------------------------------------------------- |
| `filePreview.observe`   | `filePreview.read`                                              | Conditional committed metadata, or `null` when closed.   |
| `filePreview.providers` | `filePreview.read`                                              | Renderer choices at an exact preview revision.           |
| `filePreview.action`    | `filePreview.write`                                             | Accept close, retry, dock, undock or provider selection. |
| `filePreview.open`      | `filePreview.write` and source-specific `fs.read` / `sftp.read` | Accept an explicit absolute target.                      |

`observe({revision?})` returns `{schemaVersion:1,revision,changed}`. Only changed
responses contain `snapshot`. A non-null snapshot includes activation `id`, frame
`revision`, renderer `attemptId`, explicit source/path, line/column (0 means unspecified; positive values are one-based),
`presentation:"quickLook"|"docked"`, renderer, nullable provider ID, provider count, state
and nullable error code. No contents, native tickets, URLs, raw errors or callbacks
cross this boundary. Metadata access reveals paths, so it has a separate grant.

States are `loading`, `ready`, `error` and `unavailable`. Ready means text is read,
an image loaded, media metadata loaded, or the first PDF page rendered. Acquiring a
native ticket alone does not mean ready. Public failures are `readFailed`,
`decodeFailed` or `rendererUnavailable`; detailed host errors remain in normal
diagnostics. An error is terminal for its attempt until retry/replacement.

`providers({id,revision,offset?,limit?})` defaults to offset 0/limit 16; maximum 32.
Pages contain `total`, `offset`, `nextOffset` and ordered `{id,name,renderer}` items.
Every page must use the exact committed preview revision. Pages are at most 64 KiB
serialized UTF-8; observations at most 256 KiB. Tokens permit 1–128 UTF-8 bytes
without controls; composite renderer provider IDs permit 129 bytes (two 64-byte IDs plus `:`); paths permit 1–32768 bytes without NUL. Renderer names are bounded
to 120 UTF-8 bytes. Coordinates/counts are nonnegative safe JavaScript integers.
JSON Schema character limits supplement, and do not replace, these byte checks.

Actions require `{id,revision,action}`. `selectProvider` additionally requires
`providerId`; `close`, `retry`, `dock` and `undock` accept no unrelated fields.
State-changing actions immediately consume that frame's mutation authority; docking
an already docked preview or undocking Quick Look is an accepted no-op. Retry and provider changes
create new attempts; reopening the same path creates a new activation. Old frames,
callbacks and late renderer results cannot affect replacements.

`open` requires `{source,path,line?,column?}`. A source is `{kind:"local"}` or
`{kind:"remote",sessionId}`. Local paths must be absolute for the host OS; remote
paths start with `/`. Endpoint read permission is retained by the native broker
through final authorization and reply. Closing/cancellation before acceptance
prevents dispatch; stopping the caller after acceptance does not close host-owned UI.
`{schemaVersion:1,accepted:true}` acknowledges intent, not IO/decode completion.
Observe the subsequent state; never automatically replay mutations after lost replies.

```js
import { createFilePreviewClient } from "./sdk/files/preview/client.mjs";
const preview = createFilePreviewClient(host);
await preview.open({ source: { kind: "remote", sessionId }, path: "/work/report.pdf" });
const owner = new AbortController();
const observation = preview.subscribe(
  (value) => {
    // null means closed; state describes this exact renderer attempt.
    console.log(value?.state ?? "closed");
  },
  { signal: owner.signal },
);
// Dispose with the plugin/view owner.
owner.abort();
await observation.done;
```

The SDK returns detached, frozen data. Subscriptions require an owner signal,
deliver serially and may coalesce intermediate frames. The default interval is two
seconds (range 1–60); each client admits eight subscriptions. Cancelled pending work
retains quota until it settles. Reads/actions accept signal and timeout options.

A trusted component view may declare `provider:"filePreview"`. It needs `ui.trusted`,
`filePreview.read` and at least one endpoint read grant. Users explicitly select it
in interface-provider settings. The host checks the actual target's endpoint at
mount and access; a local-only provider falls back for a remote target. Actions
independently require `filePreview.write`. `FrontendViewProps.filePreview` contains
metadata, `readProviders`, close/retry/dock/undock/select callbacks and optional-to-mount `Body`.
Mount `Body` once to arrange the existing host renderer without recreating it.
Omitting it permits metadata-only UI; duplicate mounts or rendering failures recover
to the built-in presentation. Language/theme/presentation changes preserve renderer
DOM and resources. Retained components and callbacks lose authority on replacement,
stop or revocation. Trusted UI remains trusted code, not a JavaScript security sandbox.

Wire contracts, native broker/schema, committed registry, renderer lifecycle,
presentation guard and SDK client live in separate files under their respective
`files/preview` domains. CI checks historical consumers, schemas, actual frontend
producer samples and SDK interpretation. Public byte resources use the separate
`files.content` API; preview metadata grants do not grant byte access.

## Docking and lifetime

Use **Dock preview** to move the existing renderer into a remembered workbench
group. Drag its tab or panel title to any supported split; resize it with the
shared splitter. **Open in Quick Look** returns to the dialog. The chosen mode is
remembered for subsequent previews. Moving or changing presentation retains the
activation, renderer attempt, decoded DOM and native ticket; only the committed
metadata revision changes. Closing/collapsing the panel releases file resources
and retains its layout slot. Reopening a saved empty slot never rereads an old
remote file. The command palette offers **Show file preview panel**. Discovery
reports `filePreview.presentations`; applications without dock/undock support must
not be inferred to support it from the schema version alone.
