# Host credentials and agent initialization review

## Reported problems

- The host context menu and ellipsis menu used different item renderers, spacing and icon handling.
- Editing a host did not expose its saved password. Opening a saved host required another connection confirmation even when its credentials and server key were already available.
- Assistant plugins exposed Send before checking the selected executable. A remote API worker could fail immediately with `exec: node: not found`, leaving a user message in a conversation that could not run.

## Changes

- Both menu entry points share the same item renderer, including icons, descriptions, selection state and separators.
- Host editing can save, replace or remove a password in the operating system credential store. Stored passwords are never fetched into the editor, blank input retains them, and cancelling a staged removal preserves them. A credential-store failure retains the draft and retries the existing host instead of creating a duplicate.
- `hostDirectConnect` defaults to enabled. Double-click and Enter activate a terminal directly; unavailable credentials, encrypted keys needing a passphrase, and unknown or changed server keys fall back to the connection dialog. The preference can restore the dialog for each activation.
- Trust approval now carries the fingerprint displayed to the user. A key that changes between display and approval is rejected before it can enter the trusted-host store. After approval, available credentials continue the connection.
- Target-aware assistant packages expose initialization and remote installation actions. The composer retains its draft and withholds Send until the selected profile and machine are ready. Backend checks also reject an unprepared send before appending a user message.
- Readiness is temporary and tied to the execution target and configuration revision. Protocol/runtime failures invalidate it. Configuration and target changes cannot reuse an unrelated successful check.
- Initialization runs finite executable checks and the actual structured protocol: Codex app-server, Claude Code stream-json control messages, Pi RPC, or the remote API worker's JSON-RPC. Checks do not send a user prompt. Codex account state, Claude login state and Pi selected-model availability are checked where their protocols expose them.
- System runtime use and installation require explicit confirmation. Remote installation verifies an official Node archive's SHA-256 and uses a fresh private directory. CLI installation uses a private npm prefix and cache. It does not replace system Node or modify services.

## Verification boundaries

Primary-source review on November 2, 2026 used GitHub's contents API and the vendor's Markdown documentation:

- [Codex app-server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md), content blob `e22c6bf163d6eecc8e8f28f089d26e8222a2a47b`: account state and `requiresOpenaiAuth`.
- [Claude Agent SDK query implementation](https://github.com/anthropics/claude-agent-sdk-python/blob/main/src/claude_agent_sdk/_internal/query.py), content blob `6019124aadd73b10d0822120a4b6392c70cea450`: initialization control requests and correlated responses.
- [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference.md): `auth status` returns JSON by default and distinguishes logged-in and logged-out exit codes.
- [Pi RPC implementation](https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/src/modes/rpc/rpc-mode.ts), content blob `1c0995d36ec752155f1d13b019728f9343bb263c`: selected model in `get_state`, available-model snapshot in `get_available_models`.

Frontend regression coverage includes password preservation/removal/retry, direct connection fallback, fingerprint-bound approval, matching menu presentation, draft retention, initialization cancellation, and readiness belonging to another target or model. Native tests cover settings migration and serialization. Installer shell tests use an actual shell, tar and SHA-256 checker with isolated temporary fixtures, including unusual paths and failed downloads/checksums.

The final suites passed: 716 frontend tests, 172 native Rust tests and 124 hub/plugin tests, with no skipped hub tests. TypeScript, ESLint, Clippy with warnings denied, translation consistency, native formatting, production frontend build, version checks and deterministic plugin packaging also passed. The five unrelated marketplace entries retain their previous metadata and package hashes.

Initialization establishes runtime/protocol availability and the exposed account/model state. It does not prove that an authentication token remains valid for inference, that a provider has quota, or that a subsequent network request will succeed. API-provider preflight does not make a paid inference request.

No server services or existing remote files were changed during this review. This batch does not claim an authenticated live remote agent conversation, macOS interaction, or rendered screenshot verification. No browser/computer tool is available; a previously rejected browser launch was not retried through another launcher.
