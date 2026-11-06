# Plugin API compatibility and security

[简体中文](plugin-api.zh-cn.md) · [Plugin overview](plugins-overview.en-us.md) ·
[Detailed plugin guide](plugins.en-us.md)

This guide describes the current discovery contract and security boundaries for plugin
authors. For contribution formats, limits and individual methods, consult the detailed
guide and the SDK catalogue in the independent marketplace repository. The application
and SDK can be released independently: check the target host rather than assuming every
method in an SDK exists in every host version.

## Discovering capabilities

The manifest's `apiVersion: 1` identifies the protocol; it does not promise that all
methods or their payloads are stable. The host validates this version and any declared
`engines.tunnelde` range before execution. An authorized executable plugin can call
`api.describe` with an empty object to obtain protocol version `1` and the methods
available in that host. Discovery itself requires no domain permission, but the plugin
must be approved and running. Every later request is authorized separately; appearing in
the catalogue does not grant access.

Method descriptions include `name`, `permissions`, `params`, `description`, `stability`,
`since` and `deprecated`. `params` is descriptive text, not a machine-validated schema
for that method. Older hosts can omit the stability metadata; treat it as unknown.
Ignore additional fields and unrecognized stability values.

| Stability      | Meaning                                                                                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `stable`       | A compatibility commitment for the documented request, response and authorization behavior. `since` identifies the first host version. Compatible changes may add fields or methods. |
| `experimental` | Behavior and payloads may change; discover capabilities and handle failures.                                                                                                         |
| `deprecated`   | Consult `deprecated` for migration guidance.                                                                                                                                         |

At present, `api.describe` is the method explicitly marked stable. Do not treat the
presence of settings, workspace, chat, runner or panel methods as a stability commitment.
An incompatible change to a stable contract requires an explicitly versioned migration.

The frozen discovery [request schema](../tests/fixtures/plugin-compat/api-describe-v1-request.schema.json)
and [response schema](../tests/fixtures/plugin-compat/api-describe-v1.schema.json) define
its v1 compatibility floor. Discovery emits no events. CI validates a host-produced
response and checks the method's metadata and permissions. These schemas do not define
other methods' inputs, outputs or events.

## Compatibility testing

CI loads a frozen v0.28.0 example through the current host's manifest loader and JSON-RPC
lifecycle. This exercises one historical plugin's transport and view response, not every
method, permission, event or stored-data migration. Test a plugin against the oldest
application version it declares, and again against newer hosts. Check for unavailable
methods, authorization changes and errors; do not depend on undocumented fields or a
fixed method count. The market SDK catalogue and `api.describe` can differ when their
releases are not synchronized.

The plugin-facing `sessions.list` and `sessions.connect` responses use a separate data
structure with the existing v1 fields `id`, `hostId`, `title`, `address`, `cols`, `rows`
and `connectedAt`. This separation does not make those methods stable or guarantee their
connection lifecycle and error behavior.

## Approval and runtime boundaries

Installing an executable plugin leaves it stopped. Before execution, Tunnelde asks for
approval of its source and declared permissions. Approval is bound to the package's
SHA-256 fingerprint and permissions; changes or reinstallations require fresh approval.
Consent to use an existing system Node installation is separate. Node is not bundled
with the application; a user can instead explicitly select an executable or install a
private runtime. Declarative theme and icon contributions do not require Node.

Node plugins run with the user's operating-system privileges. Manifest permissions
govern the host API; they are **not an OS sandbox** and do not prevent direct filesystem,
process or network access by Node code. Restricted mode prevents application-managed
executable Node and WASM plugins from running and blocks their host API requests. It
cannot undo previous writes or external processes started by arbitrary code. Only run
plugins from publishers you trust.

Start with `--safe-mode` or `--restricted-mode` to force restricted mode for that process.
The setting persists; removing the argument alone does not restart plugins. Host/session
snapshots do not return saved SSH passwords or private keys, and plugin approval does not
replace SSH host-key verification. See the detailed guide for recovery behavior, limits,
WASM restrictions and platform-specific invocation.
