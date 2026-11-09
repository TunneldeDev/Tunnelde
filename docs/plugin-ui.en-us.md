# Trusted frontend plugins

[简体中文](plugin-ui.zh-cn.md) · [Extension architecture](plugin-extension-architecture.en-us.md)

The experimental UI SDK is versioned separately from RPC `apiVersion: 1`.
`extensions.describe().frontend` reports its version, trust model, components and
limits. The marketplace SDK publishes `tunnelde-ui.d.mts`; it is generated from
the host's public contract, not its stores or component source paths.

Frontend commands can also contribute [host menu actions](plugin-host-menu.en-us.md).

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

This SDK adds component views and commands. Host-list replacement, complete
workbench providers and the remaining domain migrations require separate
contracts and are not implied by frontend module support.
