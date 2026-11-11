# Interface providers

[简体中文](../../../zh-cn/development/plugins/ui-providers.md) · [Trusted UI SDK](ui.md)

[Quick-access result providers](quick-access-ui.md) retain host input, consent and recovery.

[Process manager providers](processes-ui.md) share the native process service and confirmation flow.

[Background task extensions](background-tasks.md) wrap plugin work and compose the shared task list.

[Monitoring providers](monitor-ui.md) compose the shared charts and bounded resource data in the page and remote inspector.

[File browser providers](file-browser.md) additionally compose or replace the live file listing.

The experimental UI SDK supports explicit replacement of the host list and the
workbench presentation. Declare a component view with `provider: "hostList"` or
`provider: "workbench"`, omit `location`, and register that view normally through
`context.views.register`. A package may declare at most eight provider views.
Both targets require a trusted frontend; host-list providers also require
`hosts.read`. `extensions.describe().frontend.providers` reports availability.

```json
{
  "views": [
    { "id": "hosts", "title": "Host cards", "kind": "component", "provider": "hostList" },
    { "id": "desktop", "title": "Workbench", "kind": "component", "provider": "workbench" }
  ]
}
```

Users select providers in Settings → Plugins → Interface providers. Installing,
starting or registering a plugin never makes it the selected provider. The normal
fingerprint approval and runtime consent apply before selection; restoring a
profile does not grant plugin execution permissions. A stopped, missing,
restricted, revoked or failed provider uses the built-in interface. Selection is
retained until the user restores the built-in choice or picks another provider.

Workbench views receive `props.workbench` with shared `Workspace`, `Navigation`,
`Inspector` and `StatusBar` components. Mount `Workspace` exactly once during the
initial render and keep it mounted. Mount each optional surface at most once.
Arrange the surfaces using ordinary React layout and CSS; do not copy internal
stores, recreate sessions or bundle React. The host retains each surface's React
owner and moves its existing DOM to the selected mount. Switching presentations
preserves terminal DOM, editor drafts, pages, pane IDs and split ratios. The live
layout is saved before a settings-driven workbench switch. Returning to the
built-in interface uses the current layout, including later user edits, rather
than overwriting it with a stale backup.

```js
function Workbench({ workbench }) {
  const { Workspace, Navigation, StatusBar } = workbench;
  return React.createElement(
    "div",
    { style: { display: "flex", flex: 1, flexDirection: "column", minHeight: 0 } },
    React.createElement(
      "div",
      { style: { display: "flex", flex: 1, minHeight: 0 } },
      React.createElement(Navigation),
      React.createElement(Workspace),
    ),
    React.createElement(StatusBar),
  );
}
```

Window controls, permission/credential/host-key dialogs, F1 commands, task owners,
logs and the recovery bar stay host-owned. Use **Restore built-in interface** in
the recovery bar or F1 to restore access. Render errors and missing or duplicate
workspace mounts fall back and are logged without automatically retrying a broken
selection. Async/event-handler errors still need normal plugin error handling.
This is trusted code in the host context: an infinite loop, malicious DOM change
or native bridge misuse cannot be contained by a React error boundary. Restricted
mode remains the recovery route if trusted code prevents the UI from responding.

This does not complete all domain services, dependency management or platform
acceptance; those contracts remain under development. Existing stable RPC methods
are unchanged.
