# Tunnelde

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
**Ctrl/Cmd+P** opens files and existing tabs. Plugin commands, including UUID
Generator, can be run directly here and assigned keys in Settings → Keyboard Shortcuts.
Local search results open a read-only preview; remote results open the editor at the
matching line, preserving unsaved text. Search is literal, bounded, and cancellable.

The desktop application does **not** bundle or require Node for SSH, SFTP, monitoring,
settings or theme packs. Executable Node plugins require a separately selected runtime;
Tunnelde asks before discovering or using your system Node. Windows and macOS packages
are currently unsigned.

Update controls live in **Settings → Updates**: choose **Stable**, **Public beta (Beta)** or **Development (Nightly)**, and the official **GitHub** source or a compatible **custom HTTPS source**.
Automatic checks default to once daily; downloading and installing remain manual.
Windows and AppImage use signed full-package updates. Switching to Stable never
automatically downgrades a newer beta. See [update channels and mirrors](docs/releases.md#in-app-channels-sources-and-ota).

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
- Configure proxies per feature, connect through ordered SSH jump hosts, pause and
  resume file transfers with speed, remaining bytes and time estimates, and manage
  local or remote TCP forwards from a host page or the SSH terminal toolbar. Removing an unfinished transfer
  cleans its recorded staging files; offline cleanup retries after reconnection.
  A compact status-bar entry opens background transfers from any page, with grouped
  tasks, expandable details and temporary speed limits.
  Optional SSHFS and SSHFS Lite plugins mount remote directories through the same
  authenticated connection. See [network and storage](docs/network-storage.md)
  for 0.27+ features and dependency requirements.
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

## Independent AI plugins

The separate [Tunnelde Hub](https://github.com/TunneldeDev/tunnelde-hub) supplies the
marketplace, source folders and checksum-pinned ZIP packages. Install only the plugins
that you want; each has its own sidebar, settings, conversations, secrets and lifecycle.

| Plugin           | Integration                                                               |
| ---------------- | ------------------------------------------------------------------------- |
| **Codex**        | The installed `codex` binary, using Codex app-server                      |
| **Claude Code**  | The installed `claude` binary, using stream-json and its control protocol |
| **Pi**           | The installed `pi` binary, using RPC and a permission extension           |
| **Tunnelde AI**  | OpenAI-compatible Chat Completions, Responses, Anthropic or Gemini APIs   |
| **Tunnelde MCP** | Authenticated loopback MCP tools for external AI clients                  |

The coding integrations are community plugins maintained by TunneldeDev, not vendor
extensions. They execute the corresponding agent; selecting a model does not substitute
an API chatbot for a coding CLI. Authenticate the CLI on the machine where it will run.

With desktop **0.25.1+** and assistant plugins **1.3.1+**:

1. Connect a remote host in the Hosts sidebar.
2. Open the plugin's **Execution location / 运行位置** menu and choose **Local** or the
   connected machine by name. Model selection is a separate control.
3. The working directory defaults to that machine's resolved home. Use **Workspace and
   execution settings** to choose another folder or override the agent executable.
4. Send a message. Coding agents run on the selected machine over SSH stdin/stdout;
   no session ID or native helper is needed for ordinary remote execution.

Tunnelde AI also supports running its API assistant process on the selected remote.

Click the conversation title to search history and rename or delete an item directly
from its row. Untitled conversations follow the interface language. Host renames update
the target selector, and multiple terminals on the same host share one machine entry.
Select and authorize the remote Node runtime, then approve uploading the plugin into a
fresh user directory. API calls originate there; configuration and API keys travel over
SSH stdin and are not written into the deployment files. Pi asks before uploading its
small permission extension. Neither operation installs Node, installs an agent, or
changes system services.

Assistant plugins 1.4.1 keep remote source deployments under `~/.TunneldeAI/Chats/`
and private runtimes under `~/.TunneldeAI/Runtimes/`. Conversation deletion verifies
and cleans recorded source files. Known old deployment directories migrate into
`Chats` at the next approved initialization; untracked or modified files are preserved.

Four modes are available: **Ask for approval**, **Approve for me**, **Full Access** and
**ReadOnly**. Independent review needs a separate API reviewer; failure or denial falls
back to human approval. Claude Code and Pi do not provide the verified OS read sandbox
required for CLI ReadOnly, so that combination is disabled. API file tools and the Codex
read sandbox support read-only work. Plugin permissions are not an OS sandbox for
trusted executable code or arbitrary shell commands.

The optional `tunnelde-agent` helper is for MCP stdio and advanced persistent remote
supervisors. It is an Actions artifact or source build, **not a desktop Release download**.
Ordinary SSH and the normal remote CLI/assistant connection flow do not need it.

## Documentation

- [Settings and profiles](docs/settings.md)
- [Proxies, jump hosts, resumable transfers and SSHFS](docs/network-storage.md)
- [Keyboard and mouse shortcuts](docs/shortcuts.md)
- [AI local/remote setup](docs/ai-assistants.md)
- [Plugin development and security](docs/plugins.md)
- [Architecture and data locations](docs/architecture.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Optional native helper](native-helpers/README.md)
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
native-helpers/     Optional MCP/remote-supervisor executable
examples/plugins/   Minimal plugin examples
scripts/            Build, validation, packaging and release tools
docs/               User and developer documentation
```

The marketplace lives in the independent `TunneldeDev/tunnelde-hub` repository.
CI validates web, native, helper and repository checks. `dev` is the protected default branch
and contribution target; `main` contains stable releases. Use a Conventional Commit PR title.

Each `dev` update runs CI and updates one release PR targeting `main`. That PR contains the next
version, synchronized manifests and a summarized changelog. Ordinary PRs need no version edits.
Beta and stable packages publish from immutable `v*` tags, with full version titles. Run
**Prepare Beta** in Actions to select the current dev snapshot and allocate the next `beta.N`.
Nightly snapshots run independently at 22:00 UTC daily (06:00 Beijing time the following day), or
manually through **Nightly**; unchanged sources are skipped. Nightly versions include their commit
distance and source hash and never consume Beta sequence numbers.

Use **Create a merge commit** for the generated release PR. Merging tags the exact reviewed main
source and dispatches publication for Windows, Linux, Apple Silicon and Intel macOS. Every channel
stages a draft until all installers, signatures and update metadata pass verification. Beta and
Nightly publish as prereleases, preserve historical releases and never replace the latest stable.

See [Contributing](CONTRIBUTING.md) for PR conventions and [Release operations](docs/releases.md)
for branch protection, automation credentials and build recovery.
`pnpm build:local` creates an unsigned local build without requiring an updater signing key.

## License

Citation metadata is available in [CITATION.cff](CITATION.cff).

[GNU GPL version 3 only](LICENSE). See [third-party notices](THIRD_PARTY_NOTICES.md).
Copyright © 2026 quyansiyuanwang (TunneldeDev).

File icon and preview packs extend local and remote browsing without a Node runtime. Install an
icon pack for familiar file-type badges; use Space or Preview for supported images, audio, video,
PDF and Markdown. See [plugin contribution APIs](docs/plugins.md) for format declarations and limits.
