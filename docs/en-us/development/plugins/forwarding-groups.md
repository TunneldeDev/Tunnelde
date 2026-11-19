# Forwarding groups and host migration

Discover these experimental additions through `api.describe`. Call them with
`host.call` in Node or `context.api.call` in a component.

## Host-owned forwarding transports

`forwards.automation.list` returns saved rules with `revision`, nullable `groupId`,
automation preferences and runtime status. The historical `ForwardRule` payload and
`forwards.list` shape remain unchanged. Existing rules are ungrouped.

| Method                      | Permission       | Parameters                            |
| --------------------------- | ---------------- | ------------------------------------- |
| `forwards.groups.list`      | `forwards.read`  | `{hostId?}`                           |
| `forwards.groups.save`      | `forwards.write` | `{hostId,name,id?,expectedRevision?}` |
| `forwards.groups.remove`    | `forwards.write` | `{id,expectedRevision}`               |
| `forwards.move`             | `forwards.write` | `{id,expectedRevision,groupId?}`      |
| `forwards.startManaged`     | `forwards.write` | `{id,expectedRevision}`               |
| `forwards.startManyManaged` | `forwards.write` | `{items:[{id,expectedRevision}]}`     |

Group reads/saves return `{id,hostId,name,revision}`. Omit `id` to create a group;
rename requires its current revision. At most 32 groups per host and 512 globally.
Moves require an inactive rule and a group on the same host; omit/null `groupId` to
ungroup. Moving changes the rule revision and preserves automation preferences.
Delete only empty groups.

Rules in the same host/group share a dedicated SSH transport across native UI,
automatic startup/retry and plugin starts. Different groups and each ungrouped
rule use independent transports. Connection attempts for the same reviewed route
and group are coalesced. Listeners retain the transport; stopping the final listener
releases it. If connection settings change while the group still has an active transport,
new starts fail with `forward.groupConnectionChanged`; stop every rule in the group
before starting on the new route. Connection changes still undergo normal route,
credential and host-key checks. Managed plugin starts use saved credentials and trusted host keys, return
errors when those are missing, and do not open credential prompts. No secret is
returned. Plugin listener ownership is unchanged: revoking one plugin removes its
listeners without disconnecting another owner's listeners sharing that group.

`startManaged` returns null. `startManyManaged` accepts 1–16 distinct rule IDs,
starts in input order within 90 seconds and returns per-item `started`, `failed`
(with error) or `notStarted` outcomes. One failure does not roll back earlier starts.

Legacy `forwards.start/startMany` still accept `sessionId`, but now require that
session to be the host-managed transport for the rule's exact group/rule and current
reviewed route. Terminal, other-group and plugin-created sessions fail with
`forward.sessionScope`. Use the managed methods for new integrations. Configuration
and runtime changes use the existing `forwards` invalidation domain.

## Portable hosts

`hosts.transfer.export({ids})` returns a `tunnelde-hosts` version-1 document with
selected root IDs and the dependency closure: hosts, ancestor folders, effective
proxy selections, jump hosts, forward groups/rules and mount groups/rules. Passwords,
private key paths/content, tokens, sessions and arbitrary plugin storage are excluded.

`hosts.transfer.preview({document})` returns `{revision,entries,document}`. Each entry
contains `id`, `name`, `address`, `conflict`, `dependency`, `requires`, `forwards` and
`mounts`. Conflicts match normalized names or case-insensitive addresses (ignoring a
trailing dot), port and username. Nothing is overwritten.

`hosts.transfer.apply({request:{document,revision,selected,copies?,mountPoints?}})`
creates selected hosts and their required jump hosts with fresh IDs in one transaction,
remapping every relationship. Conflicts reject by default; explicitly set `copies:true`
to create copies. `mountPoints` maps original mount rule IDs to destination local paths.
A stale preview or invalid destination mount point rejects the complete import. Refresh
preview and review conflicts again. Configure credentials/key files on the destination;
system proxy selections use that device's environment. Importing never connects or
starts rules. Forward autoStart takes effect on the next launch; mount autoMount remains
a selection flag for the mount connect-and-start action.

Export/preview require `hosts.read`, `forwards.read`, `mounts.read`, `settings.read`.
Apply requires `hosts.read`, `hosts.write`, `forwards.write`, `mounts.write`, `settings.write`.
The native file format is limited to 4 MiB and 500 hosts including dependencies;
plugin RPCs retain their smaller request/response limits, so export/import smaller
batches as needed. No plugin method opens a file picker.
