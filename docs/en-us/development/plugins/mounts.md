# Shared mount rules and dedicated connections

Mount configuration and runtime belong to the host. SSHFS implementations share
rules, groups and operation receipts. Changing `mountHostDetailsSelection` changes
presentation only. Discover implemented methods with `api.describe` and capabilities
with `extensions.describe().mounts`. See [host details](host-details.md) for registration.
The UI contract exports `MountGroup`, `MountRule`, `MountSnapshot` and `MountOperation`.

`mounts.read` reads shared state, dependency and path checks. `mounts.write` changes
configuration, starts/stops transports and cancels operations. A mount host-details
contribution additionally needs `mounts.hostDetails`.

## Migrating one-off views

Check the running host, not a bundled SDK catalogue. Use `context.api.call` in a
component or `host.call` in Node. A host advertising
`extensions.describe().mounts.configuration === "persistent-shared"` and the
required methods in `api.describe` supports shared rules. In particular, look for
`mounts.rules.snapshot`, `mounts.groups.save`, `mounts.groups.connect`,
`mounts.groups.observe` and `mounts.runtime.connectAndStartAuto`.

Read saved groups and rules from `mounts.rules.snapshot({hostId})`; do not mirror
them in plugin-local storage. Save the group's `autoReconnect` flag, then offer
an explicit connect or connect-and-start action. The host owns the connection and
restores desired mounts. No caller-supplied `sessionId` or cross-plugin messaging
is required. Disconnect before changing a group and pass its current revision.

The legacy declarative `{ "type": "mounts" }` block still renders the one-off
panel and cannot call arbitrary RPCs. A shared-rules view currently needs a trusted
component. Keep the legacy fallback visibly separate; it does not share rules or
automatically restore them.

A group is `{id,hostId,name,autoReconnect}`. A rule is
`{id,hostId,groupId,name,remotePath,mountPoint,readOnly,autoMount}`. Reads return
`{revision,value}` or null. Saves accept `{group|rule,expectedRevision?}`: omitting
revision creates a new ID only; updates require the exact saved revision. Stop a rule
before editing it and disconnect a group before changing it. Cross-host groups are
rejected. Host deletion cascades configuration and releases runtime resources.

Use `mounts.rules.snapshot({hostId})` for configuration and runtime together.
`rules/groups.list` page 1–32 entries and return `{revision,items,nextCursor}`;
continuations require the collection revision. Limits are 32 groups/128 rules per
host, 512 groups/2048 rules globally. IDs contain ASCII letters, digits or `-_.`,
up to 128 bytes. Paths are absolute; remote Windows paths retain `/C:/...` SFTP
syntax. Local Windows mounts require an unused drive root; other platforms require
an existing empty directory. Read-only defaults true; automatic options default false.

`rules.move` moves a stopped rule within a host. `rules.copyHost` requires the
collection revision, allocates new IDs and disables copied autoMount flags.
`rules.export` returns `{revision,nextCursor,document}` where document is
`{version:1,hostId,groups,rules}`. `rules.importPreview` accepts at most 32 groups and
32 rules per batch and returns `{revision,digest,conflicts,groups,rules}`. Apply the
same document using `rules.importApply` with `expectedRevision` and `digest`.
Modes are `reject` (default), `replace` and `skip`. Every apply is atomic and cannot
replace active configuration. Re-preview each batch of a larger import.

Each group uses one dedicated host-owned SSH connection with saved credentials and
normal host-key verification. Saving/importing and changing contributors never
connect. `runtime.connectAndStartAuto({groupId})` explicitly connects and starts
that group's autoMount rules. AutoMount is a selection flag for this action;
application startup does not connect every configured host.

| Capability                        | Methods under `mounts.`                       |
| --------------------------------- | --------------------------------------------- |
| Group lifecycle                   | `groups.connect/disconnect/reconnect/remove`  |
| Individual runtime                | `runtime.start/stop/restart/retry`            |
| Ordered batch runtime             | `runtime.startMany/stopMany/startAll/stopAll` |
| Automatic rules                   | `runtime.startAuto/connectAndStartAuto`       |
| Open/reveal live mount            | `runtime.open/reveal`                         |
| Native force-unmount confirmation | `runtime.requestForceUnmount`                 |
| Shared connection state           | `connections.list/get/observe`                |
| Operation progress                | `operations.list/get/observe/cancel`          |
| Host observation                  | `groups.observe`                              |

Lifecycle actions return an operation receipt. Observe using `{id,revision}` until
phase leaves `pending/running`. Each item reports
`pending/running/succeeded/failed/blocked/cancelled`. Failed group connections block
their dependent starts while other groups continue; a failed mount does not block
independent rules. Cancellation prevents subsequent steps, without rolling back
already committed work. Limits: eight active operations, four per plugin, 256 steps
per batch and 128 retained receipts. List pages contain 16 summaries; get returns
one full receipt. Observation waits at most five seconds.

Runtime reports saved revision, runtimeId, desired state and categorized errors
(`code/message/category/retryable`). Supply runtimeId to stop a specific instance.
Cleanup failure preserves its mount reservation and configuration. Force unmount
requires native confirmation. Open/reveal verifies live identity and containment.

Revocation severs authenticated access even if normal unmount fails. Cleanup
settles only the exact owner's workers, then retries normal unmount once; it never
automatically force/lazy-unmounts a busy filesystem. A failed helper exit counts
as reconciled only when a fresh OS probe confirms the mount is absent. A still
mounted or uncertain filesystem keeps its cleanup record for explicit retry.

With autoReconnect enabled, the host restores previously requested connections and
desired rules using 2/4/8/16/32/60-second backoff, up to four groups concurrently,
and a 90-second connection timeout. Manual stop/disconnect pauses recovery.
Authentication, trust or original route changes require attention; recovery never
accepts a changed route or trusts a new key. An explicit reconnect establishes the
current route and restores rules that were desired/running when submitted.

`groups.observe({hostId,revision?,runtimeRevision?})` returns a fresh snapshot and
waits only if both versions are unchanged. `connections.observe({revision?})`
returns `{revision,items}` with an opaque runtime token. Native invalidation events
are `mounts://changed` and `mounts://operation-changed`; frontend plugins can use
observation RPCs without importing native APIs.

`paths.remote.browse({groupId,path?,offset?})` pages 128 directories through the
connected group's SFTP channel and returns nextOffset; offsets do not guarantee a
stable remote listing. `paths.remote.resolve` resolves a directory.
`paths.local.pick/validate` select/check local mount points. `paths.conflicts`
returns up to 128 overlaps plus total/truncated, with bounded filesystem workers
and a five-second deadline. `dependencies.get/refresh/documentation` detect
SSHFS/FUSE and open instructions without installing system software.

`legacy.list({hostId?,offset?})` pages 32 one-off mounts across implementations.
`legacy.convert({id,ruleId,groupId,expectedGroupRevision,name})` atomically adopts
one live mount as a persistent rule without interrupting access or taking ownership
of its original terminal SSH session. AutoMount is disabled. A later rule restart
uses the dedicated group connection. `legacy.dismiss({id})` hides only the prompt.
Old `mounts.list/mount/unmount/open` retain their original per-plugin isolation.
Stopping a contributing plugin does not remove shared configuration or host mounts.
