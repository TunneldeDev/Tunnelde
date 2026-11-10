# Process manager providers

[简体中文](plugin-processes-ui.zh-cn.md) · [Interface providers](plugin-ui-providers.en-us.md)

Declare a component view with `provider: "processes"`, a trusted frontend, and
`ui.trusted`, `sessions.read`, `monitor.read` permissions. The user selects the
provider in Settings → Plugins → Interface providers. This experimental UI SDK
contract is additive; existing stable RPC methods and protocol version are unchanged.

`props.processes.snapshot` contains the connection identity, query, sort,
selection, count, sampling status, last update and errors. `read({ revision,
offset })` returns copied, frozen rows: at most 128 per page and 65536 serialized
UTF-16 units per items array, including JSON escaping. Text is bounded and
`truncated` identifies shortened fields. Unknown or invalid metrics are `null`,
not zero. CPU total is normalized across the host; `cpuPerCore` may exceed 100%.
Network, disk and GPU telemetry depend on remote collectors and permissions.

Use `setQuery`, `setSort`, `select`, `refresh`, and `setPaused` to control the
same host service as the native view. Only `@name:`, `@pid:`, `@user:`, `@group:`,
`@cpu:`, and `@memory:` are field filters. Bare `name:` remains literal text.
Row keys are opaque and valid within one revision. Mutations require the current
connected view and committed revision. Retained immutable reads are allowed until
the provider generation is revoked; changing away and back cannot revive it.

`Entries` optionally mounts the existing native table once, including paging,
selection and process details. Switching back moves those same DOM nodes. Omission
does not stop the sampler. The host retains dialog title, close, refresh, pause,
errors, confirmation and recovery controls. A failed or duplicate mount restores
the native view. Trusted frontend modules share the host context and native bridge;
these SDK checks are not a sandbox for hostile JavaScript.

The sampler is shared per connection and scheduled after completion. Pausing a
consumer stops its automatic request demand; another open consumer can still
refresh shared data. Manual refresh works while paused. Hidden application windows
suspend sampling. Closing the last owner retires pending results. Reopening waits
for the retired SSH request to settle before sampling again. This is cooperative
ownership, not cancellation of an already executing remote collector.

`capabilities.terminate` requires additional `monitor.write`. Call
`requestTerminate({ revision, key })` to request native confirmation. The host
rechecks current provider permissions, runtime, connection and process identity
when the user confirms. Confirmations are consumed once, including while the
request is pending. Closing the view or reusing a PID invalidates the action.
The backend checks Linux process start ticks before sending TERM. This reduces
PID reuse mistakes; a shell check and subsequent signal are not an atomic kernel
process handle or a promise of immediate process exit. The legacy `monitor.kill`
RPC retains its existing behavior; it is distinct from this confirmed UI API.

Public contracts live under `contracts/monitor/processes/{entry,query,provider}`.
Private projection, context and authorization live under
`extensions/monitor/processes/`. The feature separates `data/`, `runtime/` and
`components/`; internal process identity stays host-owned. Neither plugin code
nor generated SDK declarations import those internal stores or feature modules.
