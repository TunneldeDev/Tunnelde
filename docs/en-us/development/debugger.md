# Development debugger adapter

TunneldeDebugger is a separate source-only workbench. Its adapter reuses production AppShell, controls and Services; scenario data, presets, runner orchestration and acceptance records live in the debugger repository. This is an internal development contract, separate from the stable local API.

The frontend entry requires both `import.meta.env.DEV` and `VITE_TUNNELDE_DEBUGGER=1`. Rust registers its module, commands and endpoint only under `cfg(all(feature="debugger", debug_assertions))`. Runtime activation additionally requires `TUNNELDE_DEBUGGER_ACTIVE=1`, the `dev.tunnelde.debugtarget` identifier, an isolated data/plugin directory and a marker matching the UUID run ID. Credentials use the existing application-specific vault namespace.

`src/debugger/index.tsx` mounts production components against controlled, mutable Services fixtures. Unsupported operations fail explicitly. Mock documents use in-memory storage and reload on generation changes to release singleton resources. No third-party plugin code runs in the bundled mock plugin example.

`src/debugger/native.tsx` also supports real services: backend host/settings preparation, a temporary local file, synthetic SSH/SFTP and normal workspace navigation. Both file panes start at fixture roots. The SSH fixture echoes input without a system shell; its SFTP adapter rejects traversal and symlinks. Normal production file navigation remains available to an operator.

The independent loopback TCP endpoint publishes a private descriptor containing protocol version, address, runId and an independent random token. It reuses local transport primitives, capacity limits and timeouts. Registered commands expose capabilities, apply, snapshot/events, checks and presentation; they never evaluate JavaScript or forward arbitrary Tauri invokes. The coordinator alone polls and acknowledges rendering. Requests/results require matching generations. Real-service reset uses a new process/profile. Native ownership and window-return operations retain the production lease protocol.

Adding a surface requires matching registrations in the debugger's `shared/scenarios.ts`, this adapter and Rust's registered surfaces. State presets should be marked unsupported unless the production component's state is actually adapted. Browser, native UI simulation and real-service results must remain distinguishable. Verify type checking, relevant regressions, feature/non-feature Rust builds and production bundle exclusion after modifying the boundary.

Use the debugger repository's setup command to apply its pinned integration patch in a separate worktree; do not overwrite a developer's dirty checkout. Source identity includes revision, working-change fingerprint and protocol version. Screenshots are target-window evidence; automatic checks do not grant manual visual approval.
