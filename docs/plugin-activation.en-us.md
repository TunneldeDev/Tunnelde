# Plugin dependencies and activation

[简体中文](plugin-activation.zh-cn.md)

Required runtime dependencies are experimental. They are installed plugins that
must be ready before the declaring plugin starts. They do not import JavaScript
modules, grant access to another plugin's storage, or share permissions.

```json
{
  "apiVersion": 2,
  "dependencies": [{ "id": "shared-tools", "version": "^1.0" }]
}
```

This is a manifest fragment. Keep the usual identity, runtime, entry point and
permission declarations. Version ranges use Rust `semver::VersionReq`: for example
`^1.0` or `>=1.0, <2.0`. npm union and hyphen ranges are unsupported. Prereleases
need a matching explicit prerelease comparator; a stable range does not silently
admit a prerelease dependency. Theme packs cannot require runtime dependencies.

Manifest admission version 2 is necessary because old v1-only hosts would otherwise
ignore unknown dependency fields. They reject v2 packages. Existing v1 packages
remain supported; the JSON-RPC API and its stable contracts remain version 1.
`initialize.apiVersion` reports the package's manifest version, while
`initialize.hostApiVersion` is 1. This change does not declare all APIs stable or
make the application ready for 1.0.

## Review and execution

The host plans from installed metadata without starting engines, detecting Node,
opening consent dialogs or downloading packages. Missing dependencies, incompatible
versions and cycles stop the request with specific diagnostics. Plugin details
show required package IDs and version ranges. Installation is always explicit.

Starting a plugin reviews each package and obtains its own permission approval.
Admission then binds the complete reviewed package fingerprints and original grant
generations. A package update, revocation or reapproval during a wait invalidates
the captured request; it cannot borrow a later grant. Internal preview and start
permits are process-bound WebView implementation details, not plugin SDK commands.

Every package's approved bytes, host/UI SDK compatibility and runtime are checked
before any engine starts. WASM is prepared at this stage. Node is resolved once per
plan and checked against every package's range. The host never implicitly selects
the user's installed Node: runtime selection and any system-runtime consent remain
explicit. Failed preflight preserves existing approvals and starts no plugins.

Dependencies start first. Native initialization and trusted frontend activation
must both finish before dependents become ready. Requests for the same runtime
share startup with independent waiters. Cancelling one root stops waiting for its
dependency; other waiters remain. The last unfinished waiter triggers settlement.
Already ready dependencies remain running if a root later fails or is cancelled.
Stopping or revoking a dependency retires its active dependents through the
existing runtime ownership and cleanup services. A cancellation request does not
prove that a remote resource has already stopped.

## Bounds and discovery

`extensions.describe().runtime.activation` describes support. Treat its absence
as unsupported. The directory currently reports at most 16 dependencies per
package, 64 packages, 256 edges, depth 32, and 160 UTF-8 bytes per range. Plans read
at most 4,096 installed catalogue entries. There are at most 16 concurrent graph
requests; complete preflight has a 60-second deadline. Blocking file reads and
WASM preparation retain one of 16 worker slots until actual completion, including
after the waiting request is cancelled. Shared engine startup has its own bounded
coordinator and readiness deadlines.

The host keeps declaration contracts, graph resolution, admission, preflight,
execution and coordination in separate modules under
`src-tauri/src/plugins/runtime/activation/`. SDK dependency declarations and
discovery types live under `sdk/rpc/runtime/activation/` in the plugin repository.
Marketplace publication validates declaration shape and bounds; the host's Rust
SemVer parser is the final authority for range grammar and matching. SDK sync
checks discovery limits against the host implementation.
