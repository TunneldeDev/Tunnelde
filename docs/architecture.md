# Architecture

## Layers

| Layer      | Location                                                                                                | Responsibility                                                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| UI         | `src/features/*`                                                                                        | One folder per area: welcome, hosts, connect, terminal, sftp, editor, history, monitor, plugins, settings, about, updates, dialogs     |
| Components | `src/components/{layout,ui}/*`                                                                          | Shell layout, and primitives grouped as `form`, `overlay` and `display`                                                                |
| State      | `src/store/*`                                                                                           | Zustand stores: workspace (tabs and panes), settings, hosts, ssh, transfers, editors, monitor, plugins, dialogs, toasts, updates       |
| Library    | `src/lib/{api,files,text,prefs,session,plugins}/*`                                                      | IPC wrappers and types, file operations and drag rules, formatting, appearance, terminal input, clipboard                              |
| Tests      | `tests/*`                                                                                               | Mirrors the modules above and never sits next to the implementation                                                                    |
| Commands   | `src-tauri/src/commands.rs`                                                                             | Thin `#[tauri::command]` layer that validates input and calls a module                                                                 |
| Domain     | `src-tauri/src/ssh/{session,files,monitor}.rs`, `plugins/{mod,marketplace}.rs`, `vault.rs`, `update.rs` | SSH sessions, file transfers between any two endpoints, remote sampling, plugin hosts and their marketplace, credential store, updater |
| Storage    | `src-tauri/src/db/*`                                                                                    | SQLite with numbered migrations: hosts, groups, settings, tabs, audit, known hosts, command history                                    |
| Platform   | `src-tauri/src/{lib,state,settings}.rs`, `platform/{window,tray,menu,logging,system}.rs`                | App wiring, window, tray and menu behaviour, logging, local system sampling                                                            |

## Startup and window presentation

The main native window starts hidden. Window-state restoration applies saved size,
position and maximization before settings apply native chrome and background colors.
The window-state plugin does not restore visibility or decorations; settings and the
startup/tray handlers own those choices.

The frontend applies saved appearance and language before publishing settings readiness,
then restores plugin view metadata and workspace layout before mounting the shell.
After its selected bundled fonts load, the committed shell sends `main_window_ready`.
Only then does the native layer restore fullscreen and reveal the window. Tray actions,
Dock clicks and second launches share this readiness gate. Background update status does
not delay presentation, and font failures use fallbacks. No animation-frame wait is used
because hidden webviews can suspend those callbacks.

With `releaseWebviewInTray` enabled, hiding the main window requests a frontend
checkpoint. Native code accepts only the current request token while the window
remains hidden, retains the bounded snapshot in memory and destroys the WebView.
Dialogs and view-owned writes defer the checkpoint. A cancelled request reattaches
any detached terminals. SSH terminal output uses a sequence barrier and a bounded
4 MiB queue while detached; reaching the limit applies channel backpressure rather
than truncating ANSI/UTF-8 data. Restoration uses xterm's serializer plus a pinned
adapter for parser modes, saved cursors and partial control/UTF-8 sequences.

The process remains alive without windows until an explicit quit. Tray/Dock and
second-launch actions recreate the original window, restore native geometry and
appearance on the main thread, and use the startup readiness gate again. WebView
creation itself runs outside synchronous event callbacks to avoid a WebView2
deadlock. Geometry restoration runs on the main thread to avoid a window-state
cache/resize-event lock inversion. Bootstrap reconciles native sessions, transfers
and plugin events after restoring the memory-only workspace and drafts.

## Data

- Database: `<app data>/tunnelde.db` (SQLite, WAL).
- Plugins: `<app data>/plugins/<id>/`.
- Logs: the platform log directory, or `<data>/logs` when the override is set.
- Passwords: OS credential store, service `dev.tunnelde.app`, account = host id.

Environment overrides: `TUNNELDE_DATA_DIR` (throwaway profile), `TUNNELDE_PLUGINS_DIR` (separate
plugin root), `TUNNELDE_NODE` (Node executable for plugins).
`TUNNELDE_NODE` is consulted only after system-runtime consent; it does not bypass runtime
approval. Plugin settings/conversations live in per-plugin storage, and plugin secrets have
separate OS-keyring identities. Portable settings profiles exclude this data.

## Assistant execution

The independent hub contains four self-contained assistant packages. A controlled chat block
keeps model configuration separate from its selected local/SSH execution target. Active SSH
metadata supplies the location menu; SFTP resolves home/cwd without directory listings. Saved
target identities rebind only to the same host after reconnecting.

Codex app-server, Claude Code stream-json and Pi RPC use the bounded native task transport
locally or over an SSH exec channel. Pi's permission extension is explicitly deployed to a
fresh user directory. Tunnelde AI can start its API runtime remotely over the same transport;
the desktop bridge routes tools to the fixed selected scope, limits callbacks and task ownership,
and passes configuration and selected credentials through SSH stdin. Normal runs use the active
connection. Optional native supervisors provide the separate detached/persistent mode.

## Network and resource lifecycle

`network.rs` resolves host/plugin overrides, per-feature choices, the global
default and system routing. HTTP clients and SSH TCP use the same profile model;
proxy passwords remain in the vault under `proxy:<id>`. SSH supports bounded HTTP
CONNECT and SOCKS5 negotiation. Jump routes live under `route:<host-id>` in SQLite.
Each hop checks its actual server key before authenticating; nested SSH channels
and jump handles stay owned by the destination session.

Durable desktop transfers journal tasks under `transfer:<id>`, per-file checkpoints
under `transfer-file:<id>:…`, and overwrite recovery intent under
`transfer-backup:<id>:…`. Stable host IDs rebind tasks after reconnecting. Full
prefix verification, source stamps and owned-backup checks protect resume and
overwrite recovery. Plugin transfers retain runtime ownership instead of acquiring
restart-persistent permissions.

The forwarding registry owns listeners, active sockets and remote forwarding
routes, with cancellation tickets covering setup as well as active connections.
Disconnect, deletion and plugin revocation cancel only the relevant resources.
The mount registry owns SSHFS child processes and direct SFTP stdio bridges,
reserves canonical mount points, and checks OS mount visibility before reporting
success. Both registries track plugin runtime generations, so an older runtime's
exit cannot close a replacement runtime's resources. Busy mount cleanup retains
a retryable record while authenticated access is severed immediately.

Declarative plugins contain bounded JSON views, contribute no executable commands,
and never invoke Node. `mounts.*` and `forwards.*` use separate read/write permissions;
native UI blocks and executable host calls share the same authorization and ownership.

## Events

`src/lib/events` owns typed native and local domain subscriptions. Native events share one
transport listener per event name. Each caller owns an independent, idempotent disposer and
can supply an `AbortSignal`; disposing during registration also releases a late listener.
Listener failures are isolated, and diagnostics contain names and subscriber counts rather
than payloads. The bus retains no event history or application state. SSH byte chunks are
delivered in arrival order without debounce, coalescing or replay.

Bootstrap owns its listeners, appearance observers, workspace subscription and persistence
timer. Failed native registrations retry independently with a bounded backoff; recovery reads
the corresponding settings, plugins, security, sessions, updates or transfer snapshot. Stores
remain responsible for rejecting stale snapshots. Disposing bootstrap aborts pending setup,
releases subscriptions and flushes scheduled workspace persistence. This prepares the lifecycle
for window recreation; it does not yet destroy the WebView when hiding to the tray.

Subscription groups provide transactional registration for plugin workspace requests and
marketplace listeners: partial failure releases successful and late listeners, and the group
can restart. Marketplace recovery reads configuration again to reconcile edits missed during
registration failure. Local history and file invalidations use typed helpers while preserving
the browser CustomEvent boundary for integrations. History registers before its first read
and uses request revisions to prevent an older read from replacing a newer result.

| Event                | Payload                                                       |
| -------------------- | ------------------------------------------------------------- |
| `ssh://data`         | Terminal bytes from a session                                 |
| `ssh://closed`       | Session id and reason                                         |
| `sftp://transfer`    | Transfer progress, completion and errors                      |
| `sftp://changed`     | Reconcile durable tasks after creation or deferred cleanup    |
| `plugin://state`     | Plugin status after start, stop or failure                    |
| `plugin://event`     | Plugin identity, runtime generation and bounded event payload |
| `settings://changed` | Committed application preferences                             |

Command-history views also subscribe to successful history-recording notifications so mounted
host-specific panes update without relying on navigation.

## Release flow

`dev` is the protected default branch and contribution target. `main` contains stable releases.
Contributions can rebase or squash merge into dev; every retained commit subject is checked as
a Conventional Commit. Release collection associates rebased commits with their PR and retains
individual authors, coauthors and change descriptions. Main promotions use **Create a merge commit**.
Every dev update maintains one generated `release/dev-to-main` PR without starting installer builds.
The PR tree comes from dev with synchronized versions, a summarized changelog and a source marker.
Its preparation commit has main/dev parents so the final promotion preserves original dev SHAs.
Historical changelog entries remain intact; actual refs are rechecked before generated refs change.

Beta and stable publication are triggered by immutable version tags. The manual **Prepare Beta**
workflow versions an isolated dev snapshot and explicitly dispatches the tag publisher because
`GITHUB_TOKEN` tag writes do not trigger push workflows. Stable promotion tags the reviewed main
merge and uses the same publisher. Nightly has an independent daily/manual workflow, source-derived
versions and no-change detection. Its numeric commit distance sorts correctly under SemVer.

The reusable Release workflow builds all four desktop targets and validates signatures, every
installer and `latest.json` before making a draft public. Release titles include full version tags.
Tagged sources remain valid when dev advances during a build; ancestry is still verified. Historical
releases and tags remain available. Beta and Nightly cannot become the latest stable release.
The app exposes Stable, Beta and Nightly channels and chooses by SemVer, never release-list order.
Helpers remain Actions artifacts and are rejected in desktop release downloads.

The repository token explicitly dispatches CI on generated PR heads and writes PR-policy status;
no personal token or App credential is needed. The privileged policy workflow executes only trusted
target-branch code. Main and dev remain protected, with no bot bypass or direct release commits.
See [release operations](releases.md) for protection, source checks and recovery.

Both macOS desktop architectures build on `macos-15-intel`. Rust and the installed Apple SDK
cross compile `aarch64-apple-darwin`; the x64 build targets `x86_64-apple-darwin`. Each app is
ad-hoc signed and checked for its expected Mach-O architecture and a valid code signature before
the release is published. Updater signatures remain separate. This avoids depending on the
capacity of hosted Apple Silicon runners; it does not replace testing the app on Apple Silicon.
Native helper CI runs on Intel macOS and also compiles/checks an arm64 binary.

The desktop library emits only `rlib`, which the application executable consumes; it does not
build unused C static/shared libraries. Full LTO and size optimization remain enabled. Release
dependency caches use a stable shared key per target, so the Build performance workflow can
restore and refresh the same cache from `main`, where future tagged releases can access it.
The reusable release workflow runs from `main`, keeping reusable dependency caches accessible
to later releases instead of scoping them to one tag.

Dispatch Build performance to compare the previous three-library configuration with `rlib`
using the same source, compiler, release profile and Intel runner image. Its summary reports
wall time and raw/gzip executable sizes; Actions artifacts retain Cargo's compiler timing charts.
Check cache restore logs before comparing runs. Release builds also retain compiler timings as
Actions artifacts. Neither measurements nor compiler reports are added to public release assets.

To recover an interrupted draft with updated build infrastructure, dispatch Release from `main`
with `existing_tag` set to its original version tag. This builds the original tagged source, reuses its draft, replaces desktop assets and
regenerates the validated updater manifest. It never moves the tag or bumps a version and refuses
to overwrite a public release. Optional helper artifacts remain in the original workflow run unless `build_helpers` is selected.

CI checks repository hygiene, Rust (fmt, clippy, tests), Web (version/i18n checks, typecheck,
lint, tests, build), and native helpers across Windows, macOS and Linux. The independent hub
validates package manifests, deterministic archives/checksums, SDK metadata and plugin tests.
