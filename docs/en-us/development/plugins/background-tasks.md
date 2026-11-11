# Background task extensions

[简体中文](../../../zh-cn/development/plugins/background-tasks.md) · [Interface providers](ui-providers.md)

The experimental trusted frontend SDK separates **own work execution** from
**cross-feature task presentation**. These interfaces are unrelated to the `tasks.*`
process RPC namespace. They do not grant file, network or command permissions.

Use the optional `ctx.backgroundTasks?.run(options, work)` to wrap this plugin’s
cooperative asynchronous work. The host assigns `pluginId`; plugins cannot claim
another owner. Options include `title` (up to 512 UTF-16 units), `visible` (default
true), `cancellable` (default true) and an optional caller `AbortSignal`. The
callback receives its linked `signal` and `report({ message?, progress? })`.
Messages are limited to 4096 units; progress contains finite nonnegative
`completed`, optional `total`, and optional `bytes`, `items` or `percent` unit.
Reports are copied and reject after cancellation, settlement or runtime retirement.
The returned promise preserves the result or failure of the work.

At most eight operations may remain pending per runtime. Stopping, replacing or
revoking the plugin cancels its task signals. Cancellation is cooperative: arbitrary
JavaScript and remote effects cannot be forcibly stopped or rolled back. A task
stays running until its work actually settles. Hidden work is omitted from the
public list but still prevents WebView suspension while pending. Settled hidden
records are removed. Visible settled history uses the existing bounded application
history; this is not durable job execution across application exit.

For task presentation, declare a component view with `provider: "backgroundTasks"`,
no `location`, and permissions `ui.trusted` and `backgroundTasks.read`. Register
the component normally; users select it explicitly in Settings → Plugins →
Interface providers. Installation never selects it automatically.

`props.backgroundTasks.snapshot` reports a revision, `floating` or `embedded`
presentation, and visible task counts by status. `read({ revision, offset? })`
returns immutable explicit rows, up to 128 entries and 65536 serialized UTF-16
units for the items array per page. Follow `nextOffset`. Rows include source,
host-assigned plugin ownership, status, execution location, bounded progress and
messages, and action descriptors without callbacks. Excess action descriptors may be omitted to keep JSON-escaped rows within the page budget. Keys are opaque and only valid
within the snapshot revision. Hidden tasks and internal source fields are excluded.
Retained reads remain immutable but must still pass current authorization checks.

Cross-source actions additionally require `backgroundTasks.write` and
`capabilities.actions`. Call `runAction({ revision, key, actionId })` only from the
current visible provider frame. Stale frames, replaced source generations,
revoked selections, unavailable or disabled actions reject. Concurrent calls to an
already pending action reject, including after progress updates. Only advertised
actions are available; transfer reconnect, conflict review and other specialized
controls remain in the native task presentation with their original confirmations.

The optional `Entries` component mounts existing native task details at most once.
Omitting it changes presentation without cancelling tasks. The host retains window
controls, docking, bulk clear and recovery. Restoring the native view preserves
mounted task DOM; provider failure or duplicate Entries mounts recover it. Trusted
code shares the WebView execution context; these guards are not a JavaScript sandbox.

Public contracts are split by responsibility under
`src/lib/extensions/contracts/backgroundTasks/{entry,execution,provider}.ts`.
Private runtime and presentation adapters live under `extensions/backgroundTasks/`;
the task core separates model, registration, action control and execution under
`lib/tasks/`. Compatibility barrels only export existing names. The SDK mirrors
public files and checks dependency cycles and private imports. These interfaces
remain experimental and do not expand the stable RPC promise or establish 1.0 readiness.
