# Tunnelde

A cross-platform SSH, SFTP and remote-ops workbench for Windows, macOS and Linux.

Tunnelde is built with **Tauri 2 + Rust + React + TypeScript**. It is designed for people who live
in remote shells: multi-tab sessions, a dual-pane file manager, remote monitoring, a credential
vault and a permissioned plugin system.

Tunnelde is developed by **quyansiyuanwang** under the **TunneldeDev** organization.

## Status

Early development, built in public milestone by milestone.

- `v0.1.x` — workspace shell, host library, settings, GitHub Releases auto-update
- `v0.2.x` — SSH terminal with host key trust, vault, command history
- `v0.3.x` — SFTP file manager and transfer queue
- `v0.4.x` — remote monitoring and process tools
- `v0.5.x` — plugin host, TypeScript plugins, MySQL plugin
- `v1.0.0` — hardening, marketplace and full documentation

## Stack

| Layer      | Choice                                             |
| ---------- | -------------------------------------------------- |
| Shell      | Tauri 2, Rust, Tokio                               |
| UI         | React 19, TypeScript, Vite, xterm.js               |
| Storage    | SQLite (rusqlite) + OS keychain                    |
| SSH / SFTP | russh, russh-sftp, optional system OpenSSH backend |
| Plugins    | JSON-RPC 2.0 over stdio, Node and WASM runtimes    |
| Updates    | Tauri updater, GitHub Releases                     |

## Development

Prerequisites: Rust 1.92+, Node.js 24+, pnpm 10+, and the platform WebView dependencies
(WebView2 on Windows, WebKitGTK 4.1 on Linux, WKWebView on macOS).

```bash
pnpm install
pnpm tauri dev
```

Checks before a commit:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
cargo fmt --manifest-path src-tauri/Cargo.toml --all
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

Release builds sign the updater artifacts. Export `TAURI_SIGNING_PRIVATE_KEY` and
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` before running `pnpm tauri build`; the public key lives in
`src-tauri/tauri.conf.json`.

```bash
pnpm tauri build
```

Repository layout:

```text
src/                  React workspace (components, features, stores, i18n, styles)
src-tauri/            Rust core, Tauri configuration and capabilities
assets/brand/         Icon master
build/, resources/    Packaged icons, tray assets, installer bitmaps
public/brand/         Web assets served by Vite
scripts/brand/        Icon generation and verification
scripts/ci/           Repository hygiene checks
```

## Platforms

- Windows 10/11 x64 — NSIS, automatic updates
- macOS 12+ — Apple silicon and Intel DMG, manual updates while unsigned
- Linux x64 — AppImage (automatic updates) and deb (manual updates); requires WebKitGTK 4.1

macOS builds are currently unsigned, so macOS updates are offered as manual DMG downloads.
Windows builds are unsigned for now; SmartScreen may warn on first launch.

## License

Tunnelde is free software licensed under the **GNU General Public License,
version 3.0** (`GPL-3.0-only`).

You can redistribute it and/or modify it under the terms of the GNU General
Public License as published by the Free Software Foundation, version 3 of the
License.

Tunnelde is distributed in the hope that it will be useful, but **without any
warranty**; without even the implied warranty of merchantability or fitness for
a particular purpose. See the [GNU General Public License](LICENSE) for details.

Copyright (C) 2026 quyansiyuanwang (TunneldeDev). Source code for every release is available at
<https://github.com/TunneldeDev/Tunnelde>.
