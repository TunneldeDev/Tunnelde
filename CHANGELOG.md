# Changelog

All notable changes to Tunnelde are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Terminal glyphs are measured after the webfont loads, and output that arrives during that wait is replayed instead of dropped.
- Dragging the sidebar or right panel keeps whole pixels and saves the width the drag ended on, so the panel no longer springs back with a validation toast.
- The file source picker lists one row per host instead of one per open session.

## [0.16.0] - 2026-10-30

### Added

- Plugins can ship as WebAssembly: the manifest selects the runtime, every call gets a fresh instance, and the module only sees one host function for logging.


## [0.15.0] - 2026-10-30

### Added

- Settings → Plugins lists a marketplace fed by `marketplace/index.json`; installing an entry downloads its archive, verifies the pinned SHA-256 in Rust and then unpacks it.


## [0.14.1] - 2026-10-30

### Changed

- The host sidebar is a single tab stop: arrow keys move the active host, Home and End jump to the edges, and Enter opens it.


## [0.14.0] - 2026-10-30

### Added

- File panels accept a multi-selection: Ctrl/Cmd+click, Shift+click and Ctrl/Cmd+A, with delete, transfer, cut, copy, paste and drag applying to every selected entry.


## [0.13.1] - 2026-10-30

### Fixed

- Dialogs keep the keyboard focus inside themselves while open and return it when they close.
- The file list tells screen readers which row is selected, and the toast dismiss button follows the UI language.


## [0.13.0] - 2026-10-30

### Added

- `Ctrl+K` opens a command palette that searches pages, host actions, updates, panel and theme toggles and tab commands.


## [0.12.0] - 2026-10-30

### Added

- Hosts in the sidebar can be dragged into the order you want; the order is stored with the host.
- The connect dialog can install Tunnelde's public key with the password you just typed and switch the host to key authentication, so the next connection is passwordless.
- Plugins install from a `.zip` archive as well as a folder; archives are unpacked safely and capped in size.


## [0.11.0] - 2026-10-30

### Added

- File panes can show this computer or any open session, so two servers can be browsed side by side.
- Dragging a file or folder between panes copies it, folders included, and moving inside a pane renames it.
- Renaming happens in the row, files can be created next to folders, and the keyboard drives the list: arrows, Enter, Backspace, F2, Delete and Ctrl/Cmd+C/X/V.
- Settings → Trusted hosts replaces the list that was buried in Advanced.
- A monospace font can be chosen, Fira Code ships by default, and `Ctrl+=` / `Ctrl+-` / `Ctrl+0` resize it.
- Tags are edited as chips and filter the sidebar; the host context menu copies the ssh command or `user@host`.
- A private key can be picked from disk or pasted, and is stored with owner-only permissions.
- The plugins dialog installs from a picked or dropped folder instead of a typed path.
- Settings → General can show the OS menu bar, which mirrors the app actions in the UI language.

### Changed

- The duplicate top bar is gone: the brand, settings entry and update notice moved into the sidebar and status bar.
- The app follows the OS language on first run instead of defaulting to English.
- Dropdowns use the app's own listbox, destructive actions are red and ask first, and icon buttons line up with their rows.

### Fixed

- The connect dialog no longer shows a "previous fingerprint" when the trusted key is unchanged.
- Host rows no longer clip their text, and an empty group shows "—" instead of the word None.


## [0.10.3] - 2026-10-30

### Fixed

- The file pane only offers Paste when the clipboard entry has somewhere to go, instead of silently doing nothing.


## [0.10.2] - 2026-10-30

### Added

- The connect dialog shows the previously trusted fingerprint when a host key changed, so the two can be compared before replacing it.

## [0.10.1] - 2026-10-30

### Added

- Settings → Advanced can open the data folder next to the existing logs shortcut.

## [0.10.0] - 2026-10-30

### Added

- `Ctrl+Shift+W` closes the focused pane when the editor is split, and each pane's strip has a close button.

## [0.9.1] - 2026-10-30

### Added

- A close button on each pane's tab strip once the editor is split.

### Changed

- CI checks that the English and Chinese catalogues share the same keys.

### Fixed

- Re-dispatching a release now fails fast when the tag already exists instead of half-bumping the version.

## [0.9.0] - 2026-10-30

### Added

- Folders can be copied, moved and deleted: copying and pasting a folder now copies its whole tree, and deleting a folder removes everything inside it.

## [0.8.2] - 2026-10-30

### Added

- Plugins can be installed from a local folder after the manifest is validated, uninstalled from the same list and reloaded when folders are added by hand.

## [0.8.1] - 2026-10-30

### Fixed

- Releases publish `latest.json` once after every platform finishes, so parallel builds no longer fail with a missing-asset error.

## [0.8.0] - 2026-10-30

### Added

- Cut, copy and paste for files from the context menu or with Ctrl+X, Ctrl+C and Ctrl+V: cut moves, copy duplicates, and pasting across panes uploads or downloads. Folders are not pasted yet.

## [0.7.1] - 2026-10-30

### Added

- Tab context menu with close, close others, split right, split down and close pane.
- Host context menu with open, edit, favorite and delete.
- `Ctrl+\` splits the active tab to the right, `Ctrl+Shift+\` splits down; `Ctrl+W` now asks before discarding unsaved edits.

## [0.7.0] - 2026-10-30

### Added

- Split view: drag a tab to the edge of the editor area to open it in a second pane, drag tabs between panes to move them and close a pane to merge its tabs back.

## [0.6.0] - 2026-10-30

### Added

- Drag files between the local and remote panes to upload or download them, or inside a pane to move them into another folder.
- Right-click menus for files with open, transfer, rename, copy path and delete; the browser menu no longer appears.
- `pnpm build:local` builds an installer without the updater signature for local testing.

### Changed

- The embedded WebView no longer shows autofill suggestions, password bubbles, page context menus, browser shortcuts or devtools in release builds.

### Added

- Plugins can declare views and answer `view.render` with JSON blocks (heading, text, key/value, table) that the host renders in a tab.

## [0.5.3] - 2026-10-30

### Added

- Monitor tab with live CPU, memory and network charts, plus average and peak values for the session.

## [0.5.2] - 2026-10-30

### Added

- Settings → Advanced lists the trusted host keys and can forget them.

### Fixed

- Deleting a host also removes its stored password from the OS credential store.

## [0.5.1] - 2026-10-30

### Added

- Command history for every host, captured from the terminal, searchable and re-runnable from the History tab.
- Release automation: scripts bump every manifest, cut the changelog section and are wired into the Release workflow.

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
