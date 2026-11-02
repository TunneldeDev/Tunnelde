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

## Workbench

- Organize, search, tag, favorite and reorder hosts. Connect with passwords, key files
  or pasted private keys; host-key trust and credentials have dedicated controls.
- Use an xterm.js terminal with ANSI colors, Unicode grapheme widths, monospace fonts,
  native clipboard integration, configurable mouse behavior and live command history.
- Browse any two local/remote locations independently. Sort, filter, group, rename
  inline, create files or folders, drag transfers and edit remote text files.
- Drag tabs and sidebar panels into splits. Lock a pane as the destination for new
  pages; hide and restore docked panels with their placement and size remembered.
- Inspect remote CPU, memory, network and disk I/O timelines with scales, timestamps
  and mouse or keyboard sample inspection. Process termination requires confirmation.
- Customize themes, individual colors, fonts, terminal behavior and keyboard shortcuts.
  Export preferences and switch named profiles without exporting hosts or credentials.
- Choose native or compact title bars. On macOS, closing retains the window and SSH
  sessions; clicking the Dock or tray restores it. Settings → General controls whether
  the Dock icon remains visible in the background. Use Quit to exit.

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

With desktop **0.25.0+** and assistant plugins **1.3.0+**:

1. Connect a remote host in the Hosts sidebar.
2. Open the plugin's **Execution location / 运行位置** menu and choose **Local** or the
   connected machine by name. Model selection is a separate control.
3. The working directory defaults to that machine's resolved home. Use **Workspace and
   execution settings** to choose another folder or override the agent executable.
4. Send a message. Coding agents run on the selected machine over SSH stdin/stdout;
   no session ID or native helper is needed for ordinary remote execution.

Tunnelde AI also supports running its API assistant process on the selected remote.
Select and authorize the remote Node runtime, then approve uploading the plugin into a
fresh user directory. API calls originate there; configuration and API keys travel over
SSH stdin and are not written into the deployment files. Pi asks before uploading its
small permission extension. Neither operation installs Node, installs an agent, or
changes system services.

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
CI validates web, native, helper and repository checks. Release builds target Windows,
Linux, Apple Silicon and Intel macOS, then verify and publish one shared release.

Use **Actions → Release**, or prepare a reviewed local release:

```sh
pnpm release:prepare --part patch
pnpm version:check
pnpm release:notes <version>
```

Commit the coherent change and tag `v<version>`; pushing the tag triggers release builds.
The preparation script updates both native manifests/locks and the desktop manifests.
`pnpm build:local` creates an unsigned local build without requiring an updater signing key.

## License

[GNU GPL version 3 only](LICENSE). See [third-party notices](THIRD_PARTY_NOTICES.md).
Copyright © 2026 quyansiyuanwang (TunneldeDev).
