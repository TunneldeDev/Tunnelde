# Tunnelde

[简体中文](README.zh-cn.md)

A desktop SSH and SFTP workbench for Windows, macOS and Linux, maintained by
**quyansiyuanwang / TunneldeDev**. Built with Tauri 2, Rust, React and TypeScript.

## Install

Download a desktop installer from [GitHub Releases](https://github.com/TunneldeDev/Tunnelde/releases).

| Platform                          | Downloads                                  | Updates                                         |
| --------------------------------- | ------------------------------------------ | ----------------------------------------------- |
| Windows 10/11 x64                 | NSIS `.exe`                                | In-app updater                                  |
| macOS 12+, Apple Silicon or Intel | Matching `.dmg`                            | Manual DMG updates while builds remain unsigned |
| Linux x64                         | AppImage or `.deb`, WebKitGTK 4.1 required | In-app AppImage updates; manual deb updates     |

Press **F1** for Quick Access: `>` lists application and installed plugin commands,
`%` searches file contents in the selected local/SSH directory, and `@` finds hosts.
**Ctrl/Cmd+P** opens files and existing tabs. Installed plugin commands can be run
directly here and assigned keys in Settings → Keyboard Shortcuts.
Local and remote text results open the editor at the matching line, preserving unsaved
text. Other supported file types open a preview. Search is literal, bounded, and cancellable.

The desktop application does **not** bundle or require Node for SSH, SFTP, monitoring,
settings or theme packs. Executable Node plugins require a separately selected runtime;
Tunnelde asks before discovering or using your system Node. Windows and macOS packages
are currently unsigned.

Update controls live in **Settings → Updates**: choose **Stable** or **Public beta (Beta)**, and the official **GitHub** source or a compatible **custom HTTPS source**.
The update channel defaults to Stable, including on Beta installations.
Automatic checks default to once daily; downloading and installing remain manual.
Windows and AppImage use signed full-package updates. Switching to Stable never
automatically downgrades a newer beta. See [update channels and mirrors](docs/releases.en-us.md#in-app-channels-sources-and-ota).

## Workbench

- Organize, search, tag, favorite and reorder hosts. Filter inside the search field with
  `tag:PublicNet`, `@tag PublicNet`, quoted tags or `is:favorite`; choose tag suggestions
  with the mouse or arrow keys and Enter. Connect with passwords, key files
  or pasted private keys. Save passwords while editing a host and double click to
  connect directly; unknown or changed server keys still require explicit trust.
- Use an xterm.js terminal with ANSI colors, Unicode grapheme widths, monospace fonts,
  native clipboard integration, configurable mouse behavior and live command history.
- Browse local/remote locations independently in details or Finder-style columns.
  Expand breadcrumb folders, edit the full path, type a name to select it, and resize
  or detach file panels. Sort, filter, group, rename inline, create files or folders,
  connect file management directly to a saved host, and drag transfers. Select a file
  and press Space or click Preview to read local/remote text and rendered Markdown.
  Install compatible icon and preview providers from the marketplace for additional
  file types. Check each provider’s runtime and permission requirements. Media playback
  depends on the operating system’s codecs.
- Configure proxies per feature, connect through ordered SSH jump hosts, pause and
  resume file transfers with speed, remaining bytes and time estimates, and manage
  local or remote TCP forwards from the activity bar, host page or SSH terminal toolbar.
  Removing an unfinished transfer
  cleans its recorded staging files; offline cleanup retries after reconnection.
  A compact status-bar entry opens background transfers from any page, with grouped
  tasks, expandable details and temporary speed limits. Drag its title to move it,
  resize from any edge or corner, and retain its layout across reopen and restart.
  Optimized transfers use bounded SFTP request pipelines, automatic segmentation
  and shared connection budgets. Adaptive compression is available; small-file archive
  batching is not yet implemented.
  See [network and storage](docs/network-storage.en-us.md) for behavior and limitations.
- Drag tabs and sidebar panels into splits. Browse pages and plugin details in a reusable
  italic preview tab; select the same item again, double-click its tab, or interact with
  its controls to keep it open. Each pane has its own preview slot. Lock a pane as the
  destination for new pages; hide and restore docked panels with placement and size remembered.
- Inspect remote CPU, memory, network and disk I/O timelines with scales, timestamps
  and mouse or keyboard sample inspection. Process termination requires confirmation.
- Customize themes, individual colors, fonts, terminal behavior and keyboard shortcuts.
  Export preferences and switch named profiles without exporting hosts or credentials.
- Relocate settings/database, plugin packages and data, managed keys/runtimes, cache, logs
  and deployment records in **Settings → Advanced → Storage locations**. Choose folders
  individually or in a batch, review destinations, and fully quit/reopen to apply.
  Copies are verified before switching, and originals are retained for recovery.
- Choose native or compact title bars. Closing to the tray releases the WebView by
  default while native SSH sessions and transfers continue. Reopening restores the
  workspace, terminal screens and unsaved drafts. General settings also offer a
  lightweight mode that avoids GPU terminal rendering, directory preloading and
  frequent monitor sampling. On macOS, background Dock visibility is configurable.
  Use Quit to exit.

## Plugin ecosystem

The independent [Tunnelde Hub](https://github.com/TunneldeDev/tunnelde-hub) hosts the
marketplace and plugin packages. Plugins can extend the workspace with commands, panels,
themes, file tools, AI assistants and other integrations. Browse the marketplace for available
plugins and check each listing for its capabilities, runtime requirements and permissions.

Supported assistant integrations can run locally or on a connected SSH host. Setup,
authentication, approval modes and available safeguards vary by plugin and execution target;
see the [assistant guide](docs/ai-assistants.en-us.md) for details. Executable plugin permissions
are not an operating-system sandbox for arbitrary code or shell commands. Using a system
Node runtime requires explicit consent.

The optional `tunnelde-agent` helper is for MCP stdio and advanced persistent remote
supervisors. Its source and downloads are maintained in the independent
[Tunnelde-agent repository](https://github.com/TunneldeDev/Tunnelde-agent), with a separate release cycle.
Ordinary SSH and the normal remote CLI/assistant connection flow do not need it.

## Documentation

- File browser, column layouts and keyboard navigation: [English](docs/files.en-us.md) · [简体中文](docs/files.zh-cn.md)

- Settings and profiles: [English](docs/settings.en-us.md) · [简体中文](docs/settings.zh-cn.md)
- Proxies, jump hosts, transfers and SSHFS: [English](docs/network-storage.en-us.md) · [简体中文](docs/network-storage.zh-cn.md)
- Keyboard and mouse shortcuts: [English](docs/shortcuts.en-us.md) · [简体中文](docs/shortcuts.zh-cn.md)
- AI local/remote setup: [English](docs/ai-assistants.en-us.md) · [简体中文](docs/ai-assistants.zh-cn.md)
- Plugin overview and compatibility: [English](docs/plugins-overview.en-us.md) · [简体中文](docs/plugins-overview.zh-cn.md)
- Plugin development and security: [English](docs/plugins.en-us.md) · [简体中文](docs/plugins.zh-cn.md)
- Architecture and data locations: [English](docs/architecture.en-us.md) · [简体中文](docs/architecture.zh-cn.md)
- Troubleshooting: [English](docs/troubleshooting.en-us.md) · [简体中文](docs/troubleshooting.zh-cn.md)
- [Optional native helper](docs/native-helper.en-us.md)
- [Changes by release](CHANGELOG.md)

## Development

Development requires Rust 1.92+, Node 24+, pnpm 10+ and the platform WebView build
dependencies. These requirements apply to contributors, not ordinary desktop users.

```sh
pnpm install --frozen-lockfile
pnpm tauri dev
```

```sh
pnpm check
pnpm i18n:check
pnpm version:check
pnpm build
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
```

Source layout:

```text
src/                 React workbench, UI primitives, feature stores and i18n
src-tauri/           Rust SSH/SFTP core, plugin APIs, native integration and updater
examples/plugins/   Minimal plugin examples
scripts/            Build, validation, packaging and release tools
docs/               User and developer documentation
```

The marketplace lives in the independent `TunneldeDev/tunnelde-hub` repository.
CI validates web, native application and repository checks. `dev` is the protected default branch
and contribution target; `main` contains stable releases. Use a Conventional Commit PR title.

Each `dev` update runs CI and updates one release PR targeting `main`. That PR contains the next
version, synchronized manifests and a summarized changelog. Ordinary PRs need no version edits.
Beta and stable packages publish from immutable `v*` tags, with full version titles. Run
**Prepare Beta** in Actions to select the current dev snapshot and allocate the next `beta.N`.
Public Beta versions are limited to `beta.1`–`beta.9`; review and promote the stable
release before that sequence is exhausted. Published tags are immutable.
Nightly publication is disabled. Use `pnpm build:local` for development testing;
local builds do not create public releases or consume Beta sequence numbers.

Use **Create a merge commit** for the generated release PR. Merging tags the exact reviewed main
source and dispatches publication for Windows, Linux, Apple Silicon and Intel macOS. Every channel
stages a draft until all installers, signatures and update metadata pass verification. Beta
versions publish as prereleases, preserve historical releases and never replace the latest stable.

See [Contributing](CONTRIBUTING.md) for PR conventions and Release operations in
[English](docs/releases.en-us.md) or [简体中文](docs/releases.zh-cn.md) for branch protection,
automation credentials and build recovery.
`pnpm build:local` creates an unsigned local build without requiring an updater signing key.

## License

Citation metadata is available in [CITATION.cff](CITATION.cff).

[GNU GPL version 3 only](LICENSE). See [third-party notices](THIRD_PARTY_NOTICES.md).
Copyright © 2026 quyansiyuanwang (TunneldeDev).
