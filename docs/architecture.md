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

## Events

| Event                | Payload                                                       |
| -------------------- | ------------------------------------------------------------- |
| `ssh://data`         | Terminal bytes from a session                                 |
| `ssh://closed`       | Session id and reason                                         |
| `sftp://transfer`    | Transfer progress, completion and errors                      |
| `plugin://state`     | Plugin status after start, stop or failure                    |
| `plugin://event`     | Plugin identity, runtime generation and bounded event payload |
| `settings://changed` | Committed application preferences                             |

Command-history views also subscribe to successful history-recording notifications so mounted
host-specific panes update without relying on navigation.

## Release flow

`main` is the protected default branch. Feature PRs pass CI and the trusted PR-policy
workflow, then squash merge with a Conventional Commit title. Release Please maintains one
cumulative release PR, updating the frontend/Tauri/Rust versions and both native lockfiles.
Manual notes in `## [Unreleased]` move into the proposed release without removing generated notes.

Merging the release PR creates a draft bound to that exact merge commit and an immutable
`v<version>` tag. The Release PR workflow explicitly calls the reusable Release workflow;
it does not rely on a bot's tag push triggering another workflow. All four desktop builds
share the draft, then generate and validate `latest.json`. The release remains a draft until
a maintainer publishes it. Another unfinished draft blocks the next release, not unrelated
fixes. Native-helper binaries remain Actions artifacts and are rejected in desktop downloads.

The native repository token works without a persistent credential: after updating the release
branch, automation explicitly dispatches CI on that branch and sets the required PR-policy status
on its head SHA. An optional repository-scoped GitHub App can create release PRs instead.
The privileged metadata workflow executes only trusted `main` code, never PR code.
See [release operations](releases.md) for credentials, rules, recovery and version overrides.

Both macOS desktop architectures build on `macos-15-intel`. Rust and the installed Apple SDK
cross compile `aarch64-apple-darwin`; the x64 build targets `x86_64-apple-darwin`. Each app is
ad-hoc signed and checked for its expected Mach-O architecture and a valid code signature before
the draft is ready for review. Updater signatures remain separate. This avoids depending on the
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
