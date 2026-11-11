# Trusted frontend plugins

[简体中文](plugin-ui.zh-cn.md) · [Extension architecture](plugin-extension-architecture.en-us.md)

The experimental UI SDK is versioned separately from RPC `apiVersion: 1`.
`extensions.describe().frontend` reports its version, trust model, components and
limits. The marketplace SDK publishes `tunnelde-ui.d.mts`; it is generated from
the host's public contract, not its stores or component source paths.

Frontend commands can also contribute [host menu actions](plugin-host-menu.en-us.md).

## Contract organization

Public types live under `src/lib/extensions/contracts/<domain>/`. Runtime resources,
components, search, frontend lifecycle, workbench, files, terminal, history and forwarding own
separate declarations. Implementations and private stores stay outside that tree.
The existing `uiSdkContract.ts` entry only re-exports types for compatibility;
internal consumers import their domain directly.

The marketplace mirrors this dependency graph into `sdk/ui/<domain>/*.d.mts`.
Existing `tunnelde-ui.mjs` type imports remain valid; domain imports such as
`sdk/ui/terminal/surface.mjs` are also available. These are declaration imports,
not new runtime modules: activation still receives the host's SDK instance.

SDK synchronization checks every reachable public file and rejects private or
runtime imports, cycles, unexported declarations and obsolete generated files.
Historical type fixtures check old entry and domain declarations in both assignment
directions, with explicit checks for additive experimental target-union widening.
Historical fixtures remain unchanged. The UI SDK remains experimental 0.1.0;
this does not promote it to stable or change RPC method names.

## Manifest and module

A pure frontend plugin needs no Node runtime. Existing Node, WASM and declarative
plugins can add the same `frontend` declaration without changing their backend.
For combined runtimes, mark only frontend-handled commands with `frontend: true`.

```json
{
  "id": "custom-view",
  "name": "Custom view",
  "version": "1.0.0",
  "apiVersion": 1,
  "runtime": "frontend",
  "frontend": { "entry": "ui/index.mjs", "sdk": "^0.1.0" },
  "permissions": ["ui.trusted"],
  "commands": [{ "id": "hello", "title": "Hello" }],
  "views": [{ "id": "main", "title": "Custom view", "kind": "component" }]
}
```

`ui/index.mjs` exports `activate(context)`. Register only manifest-declared view
and command IDs. The host publishes views after activation succeeds. Registration
returns an idempotent release function; activation can return an optional cleanup.

```js
export function activate(context) {
  const React = context.sdk.react;
  const { Button } = context.sdk.components;
  function Counter() {
    const [count, setCount] = React.useState(0);
    return React.createElement(
      Button,
      {
        onClick: () => setCount((value) => value + 1),
      },
      `Count ${count}`,
    );
  }
  context.views.register("main", Counter);
  context.commands.register("hello", () => ({ text: "Hello" }));
}
```

Use the supplied React instance. Do not bundle React, React DOM or a JSX runtime
into the plugin. For JSX builds, use classic `React.createElement` transformation
and bind `React` from `context.sdk.react`. Relative ESM imports can load other
approved `ui/` assets. Entry paths use ASCII letters, numbers, `.`, `_`, `-` and
`/`, start with `ui/`, end with `.mjs`, and cannot contain empty or dot segments.

Host components include Button, IconButton, Field, Input, Textarea, Switch,
SearchField and EmptyState. They inherit the host theme. SearchField presets use
the same mandatory `@field:value` syntax as the application. Component props,
resource scopes and frontend context are described by the public SDK types.
Custom CSS must scope its selectors; this version does not isolate DOM or CSS.

## Trust and lifetime

Approval explicitly warns that frontend code runs in the host JavaScript context.
It can access the DOM and native bridge beyond the SDK wrapper. It is trusted
code, not a sandbox. Stopping removes host-owned registrations and revokes module
URLs and SDK calls; it cannot undo arbitrary DOM mutations, forcibly stop a loop
or remove already evaluated JavaScript. Restart in `--safe-mode` or
`--restricted-mode` when recovery requires preventing plugin execution.

The host hashes and captures the same package bytes. Approval is bound to that
digest and runtime generation; changing installed files requires new approval.
Local protocol URLs are revoked on stop, permission change and WebView teardown.
Module assets are bounded to 8 MiB per package and 32 MiB across at most 16 owners;
snapshot work and protocol requests have separate concurrency limits. Assets use
an explicit MIME allowlist and no HTML document transport. Production CSP permits
the local module protocol, not arbitrary network scripts or blob scripts.

`context.resources` owns registered cleanup and asynchronous work. Module opening,
import and activation each have a 15-second deadline; SDK calls and commands have
a 60-second deadline. Cancellation rejects callers promptly and cleans late
resources, but does not roll back native or remote side effects. Observe
`context.signal` and release timers, event listeners and other resources.

`context.api.call` uses the existing approved RPC dispatcher, permissions, input
and output bounds, and authorization checks after asynchronous work. Frontend
commands retain normal command discovery and shortcut routing. Activation and
render errors reach software logs; a failed activation stops the plugin, and
component views expose Refresh for recovery.

An engine reporting `running` does not yet imply that its frontend module is
ready. Commands and JSON view renders wait up to 15 seconds for native initialize
and the frontend activation acknowledgement, without holding the instance lock.
Each invocation remains bound to its original runtime. Stopping, replacing or
reopening its frontend invalidates unfinished results, including a close and
reactivation that happen before the next notification is processed. Cancelling
one readiness waiter does not stop a runtime another caller is waiting for.
An ordinary view refresh does not open approval or Node setup dialogs; explicit
interactive actions retain approval checks. Legacy JSON view payloads and public
SDK method signatures are unchanged.

Concurrent starts of the same admitted runtime share initialization and frontend
activation. The host requests frontend activation while the native start is still
pending, and returns success only after the ready handshake. The complete startup
has a fixed 45-second deadline, including a 15-second frontend readiness wait.
Later callers do not extend it. Cancelling one startup waiter leaves other waiters
intact; cancelling the last unfinished waiter retires a newly owned startup and
waits for local process exit. An already running runtime is retained. This does
not guarantee completion of remote or mounted-resource cleanup.

Startup coordination is bounded to 64 unfinished operations, 256 total waiting
calls and 32 waiting calls per operation. Cleanup retains its operation slot until
settlement; failed settlement quarantines that slot. Shared failures preserve the
original error code and compatibility details. The bootstrap activation listener
only loads the exact already admitted runtime; it cannot approve or start plugins.

Before registering a runtime, the host reads the installed manifest again,
compares it with the loaded metadata, and verifies the approved package bytes.
It checks the host and UI SDK ranges, compiles a missing WASM module, or prepares
the selected Node runtime before activation. A failed preparation does not create
a runtime or invalidate the original grant. Node selection and system-runtime
consent are checked again immediately before spawning. An already running Node
process is reused without resolving another executable.

Engine initialization takes a shared package read lock; installation, replacement,
removal and reload take an exclusive write lock. The read lock is released before
waiting for frontend readiness. Package replacement and removal wait for the local
child to exit. If reload cannot confirm termination, it keeps the original engine
instances and reports the failure instead of silently replacing their registry.

The SDK also supports explicit [interface providers](plugin-ui-providers.en-us.md)
for the host list and workbench presentation. The remaining domain services and
dependency management are still under development.

## Forwarding presentation providers

Declare a component view with `provider: "forwarding"` and the permissions
`ui.trusted`, `hosts.read`, and `forwards.read`. The user selects it in Settings.
`props.forwarding` is scoped to the saved host selected by the native panel.
Dynamic host sources must first be saved as an ordinary host. This experimental
contract is exported from `contracts/forwarding/entry.ts` and `provider.ts`;
private adapters live in `extensions/forwarding/`, and native presentation,
state, actions and contracts remain in their forwarding feature directories.

Read `snapshot`, then page with `read({ revision: snapshot.revision, offset })`.
Pages contain at most 128 immutable rows and 65536 UTF-16 text units. A retained
page stays readable; actions require the current host and revision. No SSH session
IDs or mutable application stores are exposed. `runtimeId` identifies an active
instance so an old Stop action cannot stop its replacement.

`Entries` optionally mounts the original native rows once. Omitting it does not
unmount the host controller or editor. Host selection, add/refresh controls,
credential/host-key dialogs, exposure warnings, editor, confirmations and recovery
remain host-owned. During editing the presentation stays mounted but hidden and
receives `visible: false`. Use `capabilities.write` to decide whether to offer
mutations; `forwards.write` is checked again at action, delayed confirmation,
authentication completion and final native admission. Completion and errors are
reported in subsequent snapshots; actions do not promise a remote transaction.

`start`, `startAll`, `stop`, `requestAdd`, `requestEdit`, `requestRemove`, and
`requestDisconnect` act on existing rows or open native controls. Plugins cannot
inject arbitrary endpoints through these UI actions. Connections are independent
background SSH acquisitions; unpublished connections are hidden from other panels
and cleaned if their scope closes. Accepted connections and listeners survive a
presentation switch but belong to the plugin runtime and close on its revocation.
Saved rules remain persisted. Changing away and back does not revive old scopes.
Prepared listeners cannot relay data before authorized commit.

Existing stable RPC methods are unchanged. The new experimental provider target
widens discovery and manifest target unions: old code that exhaustively enumerates
targets must handle unknown targets. Frozen historical fixtures remain unchanged;
checks allow only the documented additive exports and target-union widening.
Trusted frontend modules share the host context and native bridge; these checks
are not a sandbox for hostile JavaScript.

## Composing UI resource lifetimes

Check `extensions.describe().frontend.resourceScopes` or `context.resources.child`
for the experimental child-scope capability. The optional member keeps older
structural SDK implementations compatible. Create each panel or subscription scope
inside a committed React effect, then dispose it in the effect cleanup:

```js
React.useEffect(() => {
  const scope = context.resources.child?.({ limit: 8 });
  if (!scope) return; // An older host needs the plugin's explicit fallback.
  const timer = setInterval(() => { /* refresh this view */ }, 1000);
  scope.use(() => clearInterval(timer));
  return () => scope.dispose();
}, []);
```

A child inherits module cancellation; disposing it closes its descendants without
closing siblings. Moving or hiding a retained panel is different from unmounting:
keep its scope until its effect actually closes. React development-mode effect
replay creates a fresh scope; never reuse an aborted scope.

Each open child consumes one parent reservation. Work and asynchronous cleanup in
its descendants count against every ancestor, including after the child closes.
`size` includes this entire subtree. Cancellation and deadlines reject promptly,
but uncooperative work keeps its reservation until its result or failure settles;
a late acquired resource is cleaned instead of delivered. Async cleanup retains
the reservation until completion, including cleanup for an already supplied
resource rejected over quota. Cleanup failures reach the module's software log.
The module default is 128 reservations. Internal configured scopes allow at most
4096; a child may only lower its local cap, never exceed its parent's cap. Maximum
child depth is 32. A closed scope admits no new work.

These are JavaScript lifetimes, separate from `resources.snapshot/release` native
ownership and durable runner recovery. They grant no permissions, do not forcibly
interrupt trusted code, and do not undo remote operations. Closing a UI scope
alone does not stop a durable task or erase its recovery record. Use the explicit
native lifecycle and recovery APIs for those operations. Asynchronous cleanup is
observed, not a sequential transaction or a promise that process exit completed.

## Host-owned view resources

Hosts advertising `frontend.viewLifetimes` pass optional `resources` in
`FrontendViewProps`. Each committed ordinary view or selected provider instance
receives a separate module descendant. Older hosts omit this property; check the
capability and provide an explicit fallback when supporting them.

```js
function View({ resources }) {
  React.useEffect(() => {
    if (!resources) return;
    const timer = setInterval(refresh, 1000);
    return resources.use(() => clearInterval(timer));
  }, [resources]);
  return React.createElement("div", null, "View content");
}
```

Register resources in effects or event handlers, never during render. Return the
individual release callback from an effect so that effect replay or dependency
changes also clean it. The host additionally disposes forgotten registrations when
the view actually unmounts, its renderer fails or its runtime retires. Host-effect
replay uses a fresh scope; a closed scope never becomes active again.

Hiding or moving retained content preserves the same scope. Closing and reopening
creates another scope; same-ID sibling instances remain independent. A provider
selection change, including a batched A → B → A change, retires the old scope.
Changing the bound terminal, file source/session, history session, forwarding host,
monitor session or process session also changes that provider's lifetime. Ordinary
directory refreshes and changing `visible` do not. Only actual retained mounts
preserve lifetime: a layout operation that unmounts React content closes it.

The host allocates only after commit, checks the exact module token, fingerprint
and registered renderer, and shares the module's resource budget. Quota exhaustion
reports through the existing error/recovery UI without restarting siblings. Native
Workspace/Screen validation starts after the provider has actually mounted; their
portal owners retain editor state, terminal buffers and SSH connections during
selection and recovery.

`context.resources` remains module-owned. `props.resources` does not implicitly
adopt native handles, cancel RPC transport or stop durable/background tasks.
Wrap asynchronous view work with `run` or `acquire` to reject late delivery and
clean late results; underlying uncooperative work remains charged until settlement.
Use the explicit native ownership/recovery APIs when retiring those resources.
