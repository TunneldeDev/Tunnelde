# Changelog

All notable changes to Tunnelde are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.5.0] - 2026-10-30

### Added

- Plugin host: folders with `tunnelde-plugin.json` and an entry script, spawned as separate processes.
- JSON-RPC 2.0 over stdio with newline framing, initialize handshake, command calls, timeouts and log forwarding.
- Settings → Plugins lists manifests, starts and stops plugins, runs their commands and shows the last result.
- Minimal `hello` example plugin under `examples/plugins/hello`.

### Security

- Manifests validate ids, API version and permissions, and the entry script must stay inside the plugin folder.
- Each plugin runs in its own process and is killed when dropped.

## [0.4.2] - 2026-10-30

### Added

- Remote text editor: open a file from the files pane, edit it in place and save with Ctrl+S.
- Dirty tabs show a dot and ask before closing without saving.
- Binary files and files over 2 MB are rejected with a clear message.

## [0.4.1] - 2026-10-30

### Added

- Process list for the active session with pid, CPU, memory and RSS, plus a confirmed SIGTERM action.
- `TUNNELDE_DATA_DIR` to run Tunnelde against a throwaway profile.

### Changed

- Favorite hosts appear once in the sidebar instead of being repeated in their group.

## [0.4.0] - 2026-10-30

### Added

- Remote panel for the active SSH session with CPU, memory, disk, network rate, load and uptime.
- CPU sparkline and the five busiest processes, refreshed every three seconds.
- The panel falls back to the local machine view when no session is active.

## [0.3.0] - 2026-10-30

### Added

- Dual-pane file manager over the active SSH session with local and remote listings, path navigation and refresh.
- Folder creation, rename and delete in both panes, with confirmation before deleting.
- Streamed upload and download with progress, cancellation and a transfer strip.
- Files entry points on the host page and in the terminal toolbar.

## [0.2.1] - 2026-10-30

### Added

- Remember SSH passwords in the operating system credential store and reuse them from the connect dialog.
- Forget a saved password without leaving the dialog.

## [0.2.0] - 2026-10-30

### Added

- SSH sessions over russh with password and private-key authentication, PTY resize and framed terminal data.
- Trust-on-first-use host keys stored in SQLite, with a fingerprint prompt and a changed-key guard.
- xterm.js terminal tabs that keep their buffer while switching, with light and dark palettes.
- Connect dialog that reads the host key before credentials and offers to trust or replace it.
- Per-session disconnect that closes the tab and records the host as recently used.

### Changed

- Terminal tabs close themselves when the remote session ends.

## [0.1.0] - 2026-10-30

### Added

- Tauri 2 desktop shell with a React 19 workspace: tab strip, host tree, system panel and status bar.
- Host and group library stored in SQLite, with favorites, tags, notes and per-host colors.
- Settings for language (Chinese and English), theme, accent, density, text size and custom CSS.
- Custom CSS engine with import, export, validation and one-click reset.
- GitHub Releases updater: capability matrix, progress events, skip version and manual fallback.
- Tray menu, single-instance handling, window state restore and daily rotated logs.
- CI for the frontend and Rust crates, release automation with `latest.json`, and repository hygiene checks.
