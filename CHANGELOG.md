# Changelog

All notable changes to Tunnelde are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
