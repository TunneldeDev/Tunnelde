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
