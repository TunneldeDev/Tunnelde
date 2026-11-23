# Native panel API coverage

When adding a native interaction, first determine whether the same domain service
supports read, mutation, observation and cancellation, and the authorization
conditions for each action. This guide is not a runtime capability claim; use
`api.describe` and `extensions.describe` to inspect the installed version.

| Panel | Read / mutate | Observe / cancel | Follow-up review |
| --- | --- | --- | --- |
| Mounts | `mounts.rules.*`, `mounts.groups.*`, `mounts.runtime.*` | `mounts.groups.observe`, `mounts.operations.observe/cancel` | Real-device reconnect recovery |
| Plugin messaging | `bus.discover`, `bus.publish`, private member operations | `bus.receive`, `bus.unsubscribe`, request cancellation | Backpressure and SDK compatibility |
| Editor | `editor.readRange`, `editor.applyEdits` | `editor.observe` | Save, encoding, undo and redo through native editor actions |
| Hosts, files, terminal, forwarding, monitoring, settings | See [panel APIs](host-details.md#panel-actions-and-api) | Check the actual catalogue | Record UI-only actions, permissions and lifetime per panel |

Every new write action must test unauthorized calls, revision conflicts and
revocation races. Events are refresh notifications; recover from a lost event by
reading a snapshot. Actions that need a result return a queryable receipt rather
than relying on an event to confirm commit.
