# Architecture

## Layers

| Layer | Location | Responsibility |
| --- | --- | --- |
| UI | `src/features/*` | One folder per area: welcome, hosts, connect, terminal, sftp, editor, history, monitor, plugins, settings, about, updates, dialogs |
| Components | `src/components/{layout,ui}/*` | Shell layout, and primitives grouped as `form`, `overlay` and `display` |
| State | `src/store/*` | Zustand stores: workspace (tabs and panes), settings, hosts, ssh, transfers, editors, monitor, plugins, dialogs, toasts, updates |
| Library | `src/lib/{api,files,text,prefs,session,plugins}/*` | IPC wrappers and types, file operations and drag rules, formatting, appearance, terminal input, clipboard |
| Tests | `tests/*` | Mirrors the modules above and never sits next to the implementation |
| Commands | `src-tauri/src/commands.rs` | Thin `#[tauri::command]` layer that validates input and calls a module |
| Domain | `src-tauri/src/ssh/{session,files,monitor}.rs`, `plugins/{mod,marketplace}.rs`, `vault.rs`, `update.rs` | SSH sessions, file transfers between any two endpoints, remote sampling, plugin hosts and their marketplace, credential store, updater |
| Storage | `src-tauri/src/db/*` | SQLite with numbered migrations: hosts, groups, settings, tabs, audit, known hosts, command history |
| Platform | `src-tauri/src/{lib,state,settings}.rs`, `platform/{window,tray,menu,logging,system}.rs` | App wiring, window, tray and menu behaviour, logging, local system sampling |

## Data

- Database: `<app data>/tunnelde.db` (SQLite, WAL).
- Plugins: `<app data>/plugins/<id>/`.
- Logs: the platform log directory, or `<data>/logs` when the override is set.
- Passwords: OS credential store, service `dev.tunnelde.app`, account = host id.

Environment overrides: `TUNNELDE_DATA_DIR` (throwaway profile), `TUNNELDE_PLUGINS_DIR` (separate
plugin root), `TUNNELDE_NODE` (Node executable for plugins).

## Events

| Event | Payload |
| --- | --- |
| `ssh://data` | Terminal bytes from a session |
| `ssh://closed` | Session id and reason |
| `sftp://transfer` | Transfer progress, completion and errors |
| `plugin://state` | Plugin status after start, stop or failure |

## Release flow

`scripts/release/release.mjs` bumps `package.json`, `src-tauri/Cargo.toml`, `Cargo.lock` and
`tauri.conf.json`, then moves the `## [Unreleased]` changelog section into a dated one. The Release
workflow runs that script from a `workflow_dispatch` input, commits and tags the result, builds all
four platforms, and publishes `latest.json` once after every build finishes (`scripts/release/updater-json.mjs`).

CI runs three jobs: repository hygiene, Rust (fmt, clippy, tests) and Web (version and i18n checks,
typecheck, lint, tests, build).
