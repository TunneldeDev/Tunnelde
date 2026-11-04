# Changelog

All notable changes to Tunnelde are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.28.0-beta.4](https://github.com/TunneldeDev/Tunnelde/compare/v0.27.1...v0.28.0-beta.4) - 2026-11-04

### 更新概览 | Highlights

- **files:** add column browsing and reliable transfer cleanup
- **files:** add direct local and remote file previews
- **hosts:** move tag filters into search suggestions
- **workspace:** reuse preview tabs until kept open
- **ssh:** expose forwarding with clear endpoint directions

<details open>
<summary>详细变更 | Details (19)</summary>

### 新增 | New

- **files:** add column browsing and reliable transfer cleanup ([#26](https://github.com/TunneldeDev/Tunnelde/pull/26)) @quyansiyuanwang
- **files:** add direct local and remote file previews ([#28](https://github.com/TunneldeDev/Tunnelde/pull/28), [29819aa](https://github.com/TunneldeDev/Tunnelde/commit/29819aae2a8479fd4debdfab478ada885025593f)) @quyansiyuanwang
- **hosts:** move tag filters into search suggestions ([#28](https://github.com/TunneldeDev/Tunnelde/pull/28), [41ca75d](https://github.com/TunneldeDev/Tunnelde/commit/41ca75db3a07766871b12890d1492e883b461429)) @quyansiyuanwang
- **workspace:** reuse preview tabs until kept open ([#28](https://github.com/TunneldeDev/Tunnelde/pull/28), [856a314](https://github.com/TunneldeDev/Tunnelde/commit/856a314da280a9f40fe3debe98cb9faefe4eec24)) @quyansiyuanwang
- **ssh:** expose forwarding with clear endpoint directions ([#28](https://github.com/TunneldeDev/Tunnelde/pull/28), [6148d69](https://github.com/TunneldeDev/Tunnelde/commit/6148d696e8b3bc35282fd871c04f2462812b7eaa)) @quyansiyuanwang
- **forwarding:** simplify setup and rule management ([#29](https://github.com/TunneldeDev/Tunnelde/pull/29)) @quyansiyuanwang
- **transfers:** add bounded parallel SFTP transfers and resume checkpoints ([#31](https://github.com/TunneldeDev/Tunnelde/pull/31), [f899fa1](https://github.com/TunneldeDev/Tunnelde/commit/f899fa1ca83828317cce4e6c9155085c3c7d72aa)) @quyansiyuanwang
- **transfers:** add live shared bandwidth and per-task limits ([#31](https://github.com/TunneldeDev/Tunnelde/pull/31), [ec05c4f](https://github.com/TunneldeDev/Tunnelde/commit/ec05c4f6e5ae1b4c2fab4134f2bd6a3d5bafcc95)) @quyansiyuanwang
- **plugins:** add paged discovery and searchable tags ([#32](https://github.com/TunneldeDev/Tunnelde/pull/32)) @quyansiyuanwang
- **events:** add typed shared subscriptions with abortable lifetimes ([#33](https://github.com/TunneldeDev/Tunnelde/pull/33), [f70562a](https://github.com/TunneldeDev/Tunnelde/commit/f70562afbf87f76269972419a3cae787d41fee19)) @quyansiyuanwang
- **plugins:** support declarative file icon themes ([#34](https://github.com/TunneldeDev/Tunnelde/pull/34)) @quyansiyuanwang

### 修复 | Fix

- **updates:** recover channel discovery when GitHub API is unavailable ([#28](https://github.com/TunneldeDev/Tunnelde/pull/28), [d577be6](https://github.com/TunneldeDev/Tunnelde/commit/d577be615882b7a01519557931d617e53923a03c)) @quyansiyuanwang
- **workspace:** preserve plugin API pages and modified preview tabs ([#28](https://github.com/TunneldeDev/Tunnelde/pull/28), [0fdd79d](https://github.com/TunneldeDev/Tunnelde/commit/0fdd79dc424743b08c470787d20927d9e723ada9)) @quyansiyuanwang
- **tabs:** preserve page icons when keeping tabs open ([#29](https://github.com/TunneldeDev/Tunnelde/pull/29), [414a17f](https://github.com/TunneldeDev/Tunnelde/commit/414a17fee41d91a254492a5a45d6d6a761b1ece3)) @quyansiyuanwang
- **updates:** default all builds to stable channel ([#30](https://github.com/TunneldeDev/Tunnelde/pull/30)) @quyansiyuanwang
- **quick-access:** focus the complete search field ([#31](https://github.com/TunneldeDev/Tunnelde/pull/31), [bfb8068](https://github.com/TunneldeDev/Tunnelde/commit/bfb8068016d82f332bd46a0c58fb79b1519d72fb)) @quyansiyuanwang
- **transfers:** clean cancelled staging and retain pause checkpoints ([#31](https://github.com/TunneldeDev/Tunnelde/pull/31)) @quyansiyuanwang
- **events:** reconcile missed changes and release view subscriptions ([#33](https://github.com/TunneldeDev/Tunnelde/pull/33)) @quyansiyuanwang

### 文档 | Docs

- explain previews host filters and SSH forwarding ([#28](https://github.com/TunneldeDev/Tunnelde/pull/28)) @quyansiyuanwang

</details>

### 贡献者 | Contributors

@quyansiyuanwang

## [0.27.1](https://github.com/TunneldeDev/Tunnelde/compare/v0.27.0...v0.27.1) - 2026-11-03

### 更新概览 | Highlights

- **ci:** recover stalled Rust cache restores
- **startup:** restore saved appearance before showing the window
- **settings:** align network and proxy configuration layouts
- **release:** correct channels and update restart recovery

<details open>
<summary>详细变更 | Details (4)</summary>

### 修复 | Fix

- **ci:** recover stalled Rust cache restores ([#20](https://github.com/TunneldeDev/Tunnelde/pull/20)) @quyansiyuanwang
- **startup:** restore saved appearance before showing the window ([#21](https://github.com/TunneldeDev/Tunnelde/pull/21)) @quyansiyuanwang
- **settings:** align network and proxy configuration layouts ([#22](https://github.com/TunneldeDev/Tunnelde/pull/22)) @quyansiyuanwang
- **release:** correct channels and update restart recovery ([#25](https://github.com/TunneldeDev/Tunnelde/pull/25)) @quyansiyuanwang

</details>

### 贡献者 | Contributors

@quyansiyuanwang

## [0.27.0](https://github.com/TunneldeDev/Tunnelde/compare/v0.26.1...v0.27.0) - 2026-11-03

### 更新概览 | Highlights

- **network:** add proxies, jump hosts, resumable transfers, SSHFS and forwarding
- **updates:** integrate update channels and sources into settings
- **release:** support rebase merges with commit validation
- **sshfs:** compile the process launcher on Unix
- **release:** reset beta sequences for each target version

<details open>
<summary>详细变更 | Details (8)</summary>

### 新增 | New

- **network:** add proxies, jump hosts, resumable transfers, SSHFS and forwarding ([#17](https://github.com/TunneldeDev/Tunnelde/pull/17), [16ff59d](https://github.com/TunneldeDev/Tunnelde/commit/16ff59d6a32e96a77c96b50eb3cd59f424da5021)) @quyansiyuanwang
- **updates:** integrate update channels and sources into settings ([#17](https://github.com/TunneldeDev/Tunnelde/pull/17), [1ae8993](https://github.com/TunneldeDev/Tunnelde/commit/1ae8993f4e356276945b66d1506be0049890caed)) @quyansiyuanwang
- **release:** support rebase merges with commit validation ([#17](https://github.com/TunneldeDev/Tunnelde/pull/17)) @quyansiyuanwang

### 修复 | Fix

- **sshfs:** compile the process launcher on Unix ([#17](https://github.com/TunneldeDev/Tunnelde/pull/17), [062d92f](https://github.com/TunneldeDev/Tunnelde/commit/062d92fe499b44ce1cfbc4fbf4b3542eb273d079)) @quyansiyuanwang
- **release:** reset beta sequences for each target version ([#17](https://github.com/TunneldeDev/Tunnelde/pull/17), [42843e8](https://github.com/TunneldeDev/Tunnelde/commit/42843e81158a3de96a98a650bbdc02bd9735f6b1)) @quyansiyuanwang
- **ci:** recover delayed release PR checks and transient API errors ([#18](https://github.com/TunneldeDev/Tunnelde/pull/18)) @quyansiyuanwang
- **release:** preserve dev commits in stable promotions ([#19](https://github.com/TunneldeDev/Tunnelde/pull/19)) @quyansiyuanwang

### 构建 | Build

- add dev Nightly and automatic stable releases ([#15](https://github.com/TunneldeDev/Tunnelde/pull/15), [cbcf288](https://github.com/TunneldeDev/Tunnelde/commit/cbcf2889423899a2c46644e750460cfa56103fef)) @quyansiyuanwang

</details>

### 贡献者 | Contributors

@quyansiyuanwang

## [0.26.1](https://github.com/TunneldeDev/Tunnelde/compare/v0.26.0...v0.26.1) - 2026-11-03

### 更新概览 | Highlights

**Build**

- Protect main with required PR/CI checks and maintain a cumulative release PR with synchronized versions and generated notes. Build installers only after merging the release PR, and retain validated releases as drafts for manual publication.
- Build both macOS architectures on Intel runners, with arm64 cross compilation and executable/signature validation, avoiding Apple Silicon runner capacity failures. Allow interrupted draft releases to resume using updated build infrastructure without changing their tagged source.
- Stop generating unused C static/shared libraries for the desktop app while retaining full LTO and size optimization. Share release dependency caches with reproducible build measurements and keep compiler timing reports as Actions artifacts.

<details open>
<summary>详细变更 | Details (7)</summary>

### 构建 | Build

- cross-compile macOS arm64 releases on Intel runners ([00dc256](https://github.com/TunneldeDev/Tunnelde/commit/00dc25623b4b3e9f4e1242f5cbf54d6fd425f31a)) @quyansiyuanwang
- remove unused library outputs and measure release builds ([6cf7182](https://github.com/TunneldeDev/Tunnelde/commit/6cf7182ef576ac32fa46fbb11328358c51ce7fd9)) @quyansiyuanwang
- protect main and prepare reviewed draft releases ([#11](https://github.com/TunneldeDev/Tunnelde/pull/11)) @quyansiyuanwang
- **release:** summarize changelogs and add citation metadata ([#14](https://github.com/TunneldeDev/Tunnelde/pull/14)) @quyansiyuanwang
- **deps:** bump i18next from 26.5.11 to 26.5.12 ([#9](https://github.com/TunneldeDev/Tunnelde/pull/9))
- **deps:** bump lucide-react from 1.64.0 to 1.65.0 ([#10](https://github.com/TunneldeDev/Tunnelde/pull/10)) @quyansiyuanwang
- **deps:** bump googleapis/release-please-action from 8b8fd2cc23b2e18957157a9d923d75aa0c6f6ad5 to 5c625bfb5d1ff62eadeeb3772007f7f66fdcf071 ([#12](https://github.com/TunneldeDev/Tunnelde/pull/12))

</details>

### 贡献者 | Contributors

@quyansiyuanwang

## [0.26.0] - 2026-11-02

### Added

- Save, replace or remove a host password directly in the host editor using the operating system credential store. Blank fields preserve existing credentials; failed vault saves retain the draft for retry without creating duplicate hosts.
- Connect directly on host double click or Enter by default, with a Workspace preference to show the connection dialog every time. Missing credentials and untrusted or changed server keys still open the connection dialog.
- Require assistant initialization on the selected machine before showing Send. Remote runtime installation and agent preparation have explicit consent, protocol checks, available account/model-state checks and cancellation. Requires assistant packages 1.4.0.

### Fixed

- Bind host-key trust approval to the fingerprint actually displayed. A key that changes during approval is rejected and refreshed for review; approved keys with available credentials continue straight to connection.
- Render right-click and ellipsis menus with the same menu items, icons, spacing and keyboard behavior while retaining their respective pointer/button anchors.
- Select connected SSH hosts directly from the assistant location menu. Preparation errors no longer consume user messages or falsely mark a missing remote runtime as ready.

## [0.25.1] - 2026-11-02

### Fixed

- Use the full chat pane with centered message and composer columns, including editor and sidebar docking. Keep long execution-target names from pushing the send button outside narrow panes.
- Give multi-line menu entries their natural height, preventing overlapping host addresses and approval descriptions.
- Keep SSH connection names synchronized after renaming a host. Show one assistant target per saved host and connected address, preserving the selected connection instead of switching terminals.
- Replace the assistant session dropdown with searchable history and direct per-row rename/delete actions. Deleting another conversation preserves the active conversation, draft, model and approval choice; running conversations remain protected.
- Localize untitled conversations without changing custom names, and update background conversation completion in history. Requires assistant packages 1.3.1 for the new session metadata and rename action.
- Keep provider configuration in the chat toolbar and workspace options in the target menu.

## [0.25.0] - 2026-11-02

### Added

- A separate execution-location selector for assistant plugins: choose this computer or a connected SSH host directly, with automatic home-directory resolution and optional workspace/executable overrides. Requires assistant packages 1.3.0 from Tunnelde Hub.
- A native permission-checked SFTP directory resolver for plugins, accepting home-relative and relative directories without running a shell or enumerating home contents.
- Universal Quick Access with F1 / Ctrl/Cmd+Shift+P, `>` application and plugin commands, `%` directory content search, `@` hosts, and Ctrl/Cmd+P for files/open tabs. Installed plugin commands and views can be assigned shortcuts and included in settings profiles.
- Cancellable, bounded native local/SFTP search with an explicit directory selector, read-only local previews, and remote editor line navigation that preserves unsaved text.
- Host API methods to open Quick Access, set pane destination locks and resize existing splits, with normal workspace permissions and parameter validation.
- Per-turn collapsible AI activity shared by all four assistant plugins, including structured thinking, tool execution and output from the actual Codex, Claude Code and Pi protocols.

### Fixed

- Preserve composer drafts when changing execution targets creates a new conversation. Keep model selection separate from machine selection and hide obsolete manual scope setup for target-aware plugins.
- Give plugin command results a dedicated tool page, readable/resizable output, Copy and Clear controls. Render UUID/text results without their JSON wrapper and prevent the plugin detail layout from collapsing their height.
- Cancel pending host tool approvals as well as the plugin-side wait when an assistant is stopped.

### Documentation

- Rewrite the README around the current workbench, platform downloads, independent marketplace and assistant setup. Refresh settings, architecture, plugin API, security, troubleshooting and optional-helper documentation, including runtime consent and actual validation limits.
- Document official Claude Code and Codex VS Code extension investigation, source/license findings and why arbitrary VSIX packages require a separate compatibility host.

## [0.24.1] - 2026-11-02

### Added

- A macOS-only General setting to keep or hide the Dock icon while the closed window runs in the background. It defaults to visible, supports settings profiles and import/export, and restores Dock presence when the window is reopened.

### Fixed

- Reopen and focus the retained main window when clicking the macOS Dock icon after closing, hiding or minimizing it. Tray actions and relaunching use the same restoration path while preserving SSH sessions and unsaved drafts.

## [0.24.0] - 2026-11-02

### Added

- Shared CPU, memory, network and disk read/write timelines in the remote sidebar and monitor page, with timestamp-based spacing, labeled dashed scales, separate receive/send and read/write series, and mouse or keyboard sample inspection.
- Linux disk I/O sampling uses block-device counters without counting stacked devices twice, and handles device resets, removal and unavailable measurements.

### Fixed

- Keep slow remote folder loading and refresh status in the existing file-pane footer so file rows and scroll positions remain stable.
- Copy selected text from mouse-aware terminal applications such as Pi through user-triggered OSC 52 writes when copy-on-select is enabled. Preserve native selection text across TUI redraws and forward application copy shortcuts when appropriate; clipboard read requests remain unsupported.
- Refresh mounted command-history panes after successful recording, including rerun commands, without reloading unrelated hosts or changing history-recording consent.
- Size terminal grids within their actual padded content area. Terminal previews retain their sample scrollback even when SSH scrollback is disabled, and tab labels allow enough line height for descenders and CJK glyphs.
- Exclude guest CPU time from duplicate accounting in remote CPU usage.
- Create one shared draft before parallel release builds and pass its ID to every platform, preventing downloads from being split across duplicate drafts.
- Separate native helper caches by runner image to prevent incompatible Linux C libraries being restored across Ubuntu versions. Optional helper builds run independently of desktop publication.

## [0.23.0] - 2026-11-02

### Added

- Named settings profiles with one-click switching, snapshot updates, renaming and removal, plus native JSON import/export with validation and an import preview. Portable preferences include keyboard bindings and exclude hosts, credentials, plugin data, history and open tabs.
- A searchable keyboard shortcuts editor with key recording, context-aware conflict checks, unbinding and per-command or global reset. Workbench, file, editor and terminal commands share the same registry as the command palette.
- A lock button on each pane selects the default destination for newly opened pages while existing pages retain their location.

### Changed

- Approved plugins use a collapsed collection with nested permission groups and a bounded scrolling list.
- Native MCP/remote-runner helpers are distributed as separate Actions artifacts. Desktop releases contain application downloads and updater files; publication checks reject accidentally attached helpers.

### Fixed

- Ctrl/Cmd+Comma opens settings from terminal and text-input focus. Configurable shortcuts respect file-pane priority, input composition, native clipboard handling and terminal Control keys.
- Narrow pane headers keep tab close buttons reachable, place tabs below Windows window controls when necessary and reveal the active tab on resize.
- Activity icons toggle docked panels, retaining their location, split proportions and live view state. Moving sidebar panels preserves their width or height within available space instead of assigning an equal split.

## [0.22.2] - 2026-11-02

### Changed

- Codex, Claude Code and Pi use independent marketplace packages, activity views, configurations and conversation storage. Tunnelde AI now focuses on API connections, with existing CLI settings preserved for explicit migration.
- Chat panels use compact conversation controls and bottom composers with model, execution-location and approval menus. Codex adds recent conversations and an execution-location bar; Claude Code has its own brand layout and composer controls.
- Plugin chat configuration separates agent connections from independent API reviewers. Profile policies restrict each plugin to its supported agent protocol, and unsupported CLI read-only modes are explained before sending.

### Fixed

- Pane controls stay centered at the right of the tab strip without scrolling with tabs. Close-pane actions live in the pane menu, and splitting or closing panes restores keyboard focus.
- Docked plugin panels remove duplicate titles, and chat views remove the redundant refresh row while keeping recovery controls for errors.
- Radio menus support keyboard navigation, checked states, descriptive text and positioning above bottom-anchored controls.

## [0.22.1] - 2026-11-02

### Added

- Independent local and remote file-pane display preferences, clickable details headers, name and file/folder filters, and collapsible groups by type, modification date or initial. Each pane remembers its view and can restore the defaults.
- Pane-scoped Ctrl/Cmd+F filtering and Finder-style Command+Up/Down navigation and Command+Shift+Period hidden-file toggling.

### Fixed

- File selection, keyboard navigation and transfer targets follow the visible filtered and expanded list. Inline create/rename operations reveal their target without changing the other pane; fixed headers stay aligned with scrolling rows.
- Background refreshes preserve pending directory navigation, and asynchronous create/rename completion cannot overwrite another source or directory's edit state. F2 uses the selected item after deselection or context-menu changes.
- Terminal settings place the live preview inside its display/rendering subgroup, with explicit preview labeling and clearer category/subgroup hierarchy.

## [0.22.0] - 2026-11-02

### Added

- Dockable plugin chat panels with streamed Markdown, conversation drafts, model and CLI profiles, task recovery, four approval modes and native file/folder pickers.
- Scoped AI/MCP tool execution with plugin/client resource ownership, revocation, concurrent-edit checks, keyring secrets and bounded streaming local/SSH processes.
- Optional native MCP stdio bridge and durable remote agent runner for Windows, macOS and Linux. Remote deployment requires explicit runtime selection and uses a fresh user directory without changing system services.
- Host support for the independent Tunnelde MCP and Tunnelde AI marketplace plugins, including OpenAI-compatible Chat Completions, Responses, Anthropic, Gemini and structured Codex, Claude Code and Pi adapters.

### Changed

- Plugin view contributions can declare sidebar placement, controlled chat rendering and activity icons. Namespaced command IDs and minimum Tunnelde version requirements are validated.
- Plugin tool approvals preserve complete operation details with scrollable monospace previews; password fields hide provider credentials.

## [0.21.1] - 2026-11-02

### Changed

- Settings use inline subgroups for appearance, workspace, terminal and files, with nested navigation within the existing category. Group names participate in bilingual search, and switching categories restores the top of the page.
- Theme customization uses nested spacing, guide lines and stronger group headings to distinguish presets, custom colors and individual workbench/terminal controls.

### Fixed

- Built-in and plugin palettes now update the global surface tokens used by dropdowns, dialogs, context menus, native controls and other overlays. Region-only overrides stay isolated, and color previews, resets and user CSS preserve their existing behavior.
- Terminal grid remainders no longer expose xterm's black viewport background at the bottom of previews and connected terminals, in both automatic and compatibility rendering.

## [0.21.0] - 2026-11-02

### Added

- A plugin marketplace with official and custom HTTPS catalogues, publisher/source details, search, installed/update filters, offline catalogue caching, cancellable native downloads and checksum verification. Manual updates bind to the original source and restore the previous package if replacement fails.
- Three independent official plugins: JSON formatting/minifying with numeric precision preserved, Unix timestamp/date conversion and batch UUID v4 generation. Declarative plugin forms accept input and show explicitly copyable results without evaluating plugin HTML.
- On-demand Node setup with explicit consent before using an existing system executable, manual executable selection and private Node 24 LTS installation. Node is not bundled; private installations do not modify PATH or shell configuration, and system-runtime consent can be revoked.
- A full HSV color picker with HEX/RGB entry, keyboard controls, live preview, Apply/Cancel and default reset. Custom colors cover individual workbench regions, terminal background/foreground/cursor, the accent and host markers, and are shared across light and dark themes.
- Compact built-in theme palettes with collapsed regional customization. Plugins can contribute one or more named themes; the data-only Studio Themes pack supplies dark and light palettes without requiring Node or running code.
- An independent `TunneldeDev/tunnelde-hub` marketplace repository with reproducible packages, catalogue validation, contribution workflows and a dependency-free plugin SDK.
- A versioned host API for settings, hosts/groups, SSH commands, terminals, local/remote files, monitoring, history, workspace layout, clipboard, notifications and plugin-scoped storage. Per-plugin approvals bind to package content and declared permissions.
- Restricted mode in settings and through `--safe-mode` / `--restricted-mode`, immediate authorization revocation, cancellation of pending API calls, and recovery guidance after plugin failures or abnormal exits.
- Dockable Hosts, Plugins and Trusted Hosts panels with tab grouping, four-edge splits and preserved search/scroll state.

### Changed

- Plugin lists open reusable workspace detail tabs. Plugin sources and runtime choices are managed separately from appearance resets; existing plugin views and API v1 remain compatible.
- Context menus and overflow menus group actions with separators and support keyboard navigation, measured placement and predictable focus restoration.
- Removed repeated license/copyright headers from first-party source files; the repository LICENSE and third-party notices remain.

### Fixed

- Custom accent colors now apply to all accent tokens. Region resets remove persisted overrides, and terminal color previews preserve the existing terminal and connection.
- Plugin operations isolate pending actions, reject package identity/source mismatches, and recover interrupted package replacements at startup.
- Download confirmations close before long operations so progress and cancellation remain reachable. Plugin protocol reads are bounded and timeouts cover blocked writes as well as replies.
- Terminal table borders now use Unicode grapheme widths for Chinese, emoji and joined sequences; streaming UTF-8 decoding preserves characters across SSH packets.
- Plugin READMEs render Markdown, GFM tables, lists and code blocks safely without executing HTML or automatically fetching remote images.
- Windows test executables embed the same Common Controls v6 manifest as the application, fixing the missing `TaskDialogIndirect` entry point before test startup.

## [0.20.0] - 2026-11-01

### Added

- Searchable settings with bilingual keyword matching, a modified-only filter, platform-aware default/range hints, and individual, category and full resets. Numeric drafts validate before saving; custom CSS drafts survive category switches.
- Live terminal settings for scrollback, line height, active/inactive cursor shape, blinking, scrolling, copy-on-select, right-click behavior and automatic/DOM rendering, with a local preview.
- Workspace controls for status-bar visibility, startup restoration, host activation, animation preference and monitoring interval. Hosts select on single click and activate on double click or Enter.
- File-view controls for hidden entries, folders first, natural name/size/date sorting and direction, plus editor wrapping, tab width and spellcheck preferences.

### Changed

- Fresh installations follow the system language and theme, use bundled Fira Code at 14 px, keep monitoring closed, and use compact window controls on Windows and native title bars on macOS/Linux. Existing saved preferences are retained.
- Directory preloading now warms the parent and the configured number of children through a shared queue of two requests, prioritizes foreground navigation and discards stale results.

### Fixed

- Terminal preferences update existing sessions without reconnecting or clearing output. Font changes wait for loaded fonts before measuring and coalesce resize/redraw work.
- Hidden files remain part of collision checks; selection, keyboard navigation and batch actions follow the displayed sort order. Newly created hidden items reveal themselves, and new-item editing scrolls to the correct row.
- Numeric preference resets clear invalid drafts, settings saves expose pending/error state, and editor display preferences preserve unsaved text and line endings.

## [0.19.1] - 2026-11-01

### Fixed

- Packaged terminals now load xterm's runtime styles correctly. Tauri's generated style nonce previously blocked ANSI colors, character-grid styles, cursor rendering and scrollbar colors in production while development builds appeared normal.
- Terminals use xterm's WebGL renderer for accelerated drawing and continuous box graphics, with automatic DOM fallback when WebGL is unavailable or its context is lost.
- Terminal copy and paste use the native clipboard, including right-click actions, Ctrl/Cmd+V, Ctrl/Cmd+Shift+V and Windows/Linux Insert shortcuts. Multiline paste respects bracketed-paste mode; Ctrl+C copies a selection and still interrupts the shell without one.
- Shell shortcuts such as Ctrl+K, Ctrl+N, Ctrl+B, Ctrl+W and Ctrl+\ remain available inside terminals. SSH output waits for both frontend listeners, and rejected PTY or shell requests report a connection error.
- Activity-bar entries consistently switch between persistent Hosts, Trusted Hosts and Plugins sidebars without changing editor tabs. Settings remains a separate bottom entry; redundant Home and settings subpages have been removed.
- Sidebar headings, search fields and editor borders align without a spacer gap. Divider drags persist their final size and handle cancelled or lost pointer capture correctly.
- The official SDK Hello example is removed from the production marketplace, including stale remote catalogs. Plugin installation can recheck the same package and immediately reflects successful installs even if a subsequent refresh fails.

## [0.19.0] - 2026-11-01

### Added

- A workbench with an activity bar, nested editor groups, four-edge tab splitting, draggable dividers and persistent layouts. Moving tabs preserves terminal output and unsaved editor drafts.
- Inline file and folder creation, rename, keyboard navigation, path focus, selection reveal and file/folder drag transfers between local and remote panels.
- A dedicated trusted-hosts page, host drag ordering, richer host context actions, private-key file/content selection and tag suggestions.
- Plugin installation from a ZIP archive or folder picker, native drag-and-drop and a manifest preview before installation.
- System and compact title-bar options adapted to Windows and macOS, a simplified host sidebar, and quick terminal font selection with bundled Fira Code.

### Fixed

- File creation no longer truncates existing files. Copy, move and transfer operations require explicit overwrite approval, reject incompatible destinations and retain sources on failure or cancellation.
- Deleting a remote directory symlink removes the link without traversing its target. Copies and transfers reject symlinks.
- Remote text saves correctly truncate shorter contents; unsupported text encodings are rejected instead of silently replacing bytes. Saving preserves edits made during a pending save, and disconnecting retains drafts with conflict checks on reconnect.
- Closing the window asks before discarding unsaved editor drafts; closing to the tray keeps drafts and sessions alive.
- Drag routing, tab ordering, long-name layout, icon alignment, dialog focus, dropdown keyboard behavior and Chinese input in tag fields now follow consistent interaction rules.
- System language follows the operating system's preferred UI language. Terminal initialization preserves early output and correctly applies ANSI colors, themes and monospace fonts.
- Directory refreshes, connection state, plugin operations, settings writes and layout persistence reject stale results and preserve later changes.
- Remote and local monitoring pause while hidden, share samples and avoid overlapping requests. Recording raw terminal input in command history is now opt-in.
- Removed redundant application menus and repeated sidebar branding. Settings remain accessible from the activity bar.

### Changed

- Releases remain drafts until all platform builds, signatures and the updater manifest are present; version checks now include the Cargo lockfile.

## [0.18.1] - 2026-10-31

### Fixed

- The window keeps its normal frame and edge resizing; the experimental in-app title bar is withdrawn because restoring the frame broke resizing.
- The terminal also receives TERM as an environment variable, so shells that override it still report a colour-capable terminal.

## [0.18.0] - 2026-10-31

### Added

- Settings → General can draw the window buttons inside the app instead of the OS title bar, which removes the second bar on top; dragging the tab strip or the sidebar header moves the window and the edges still resize it.
- Settings → Files controls how many child folders the preload warms, and preloading is on by default.

### Fixed

- "Set up key login" now works when the password is already in the keychain instead of staying disabled.
- The sidebar header and the tab strip share the same height, so the top edge no longer steps between them.
- The right panel slides out and back with the same transition instead of popping open slowly and snapping shut, and it keeps polling only while visible.
- The expand and close buttons in the panel header sit together instead of being spread across the bar.
- Folders use a filled accent icon, so they no longer look like files.
- The terminal keeps its monospace grid, kerning and visible cursor even when the renderer's injected stylesheet is unavailable; ligatures and letter spacing are pinned to keep columns aligned.

## [0.17.0] - 2026-10-31

### Added

- Settings → Files gains "Preload parent and child folders": with it on, the panel warms the parent directory and the first few subfolders, so moving around is instant.

### Fixed

- Going up from a drive root such as `C:\work` lands on `C:\` instead of `C:`.

## [0.16.1] - 2026-10-31

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
