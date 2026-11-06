# Settings

[简体中文](settings.zh-cn.md)

File icon themes are available under **Files → Browsing → File icon theme**. Automatic
uses an installed icon theme; Plain file icons disables plugin icons. A specific selection
is preserved in profiles and exports, even if that package is temporarily unavailable.

## Application updates

**Settings → Updates** contains the current version, checks, installation progress and
collapsible release notes. All update actions use this section instead of opening a new
page. Choose **Stable** or **Public beta (Beta)**, and **GitHub** or a compatible custom
HTTPS source. Development snapshots are not offered by in-app updates. Default:
Stable for all builds, GitHub source, automatic checks once a day, manual download/installation.
Legacy Nightly preferences migrate to Stable; saved Stable/Beta choices are preserved.
Every-startup and weekly checks are also available. Expand the release notes to review
the published changes between the installed and target versions. See the update guide
in [English](updates.en-us.md) or [简体中文](updates.zh-cn.md) for history coverage and limits.

Custom source addresses use exactly one `{channel}` in the URL path, e.g.
`https://updates.example.com/{channel}/latest.json`; use **Apply** to save an edited
address. A source must serve Tauri manifests and signed packages, rather than just a web
page. Source selection and per-feature proxies are separate preferences. See
[release operations](releases.en-us.md#in-app-channels-sources-and-ota) for mirror requirements.

Switching to Stable does not downgrade an installed beta; the app waits for a newer stable version.
Update checks do not automatically download packages, and installation restarts the app. Sources,
channels and check frequency are included in settings profiles.

## File transfers

File transfer optimization is enabled under **Settings → Files → Transfers**. Concurrency,
segment size and per-segment request depth default to Automatic and can be overridden
individually. Turning optimization off retains the manual choices for later use. Changes
apply when starting/resuming a transfer; see [transfer behavior](network-storage.md#transfer-performance).

Automatic transfer compression also defaults to enabled. It compresses blocks only
when this saves traffic, skips tiny tasks and falls back to SFTP on unsupported
hosts without installing software. The compression toggle is independent of manual
segment choices and is included in exported profiles. Turning optimization off
also disables compression until optimization is enabled again.

Total upload/download limits default to `0` (unlimited), use KiB/s, and apply live
across concurrent tasks. A running transfer's gauge button opens a temporary task
ceiling; the total ceiling still applies. Both preferences travel with profiles.

Open **Transfers** in the status bar, or F1 → **Background transfers**, to inspect
tasks from any page. Pin the list to keep it open while working. Drag its title to
move it and its edges/corners to resize it. The layout is remembered across reopen,
restart and tray restoration; Reset layout or double-clicking the title restores
the default placement. See [transfer controls](network-storage.md#pause-and-resume-transfers)
for keyboard adjustments and reconnect/cleanup behavior.

## Quick Access and plugin shortcuts

- F1 / Ctrl/Cmd+Shift+P opens Quick Access in command mode (`>`).
- Ctrl/Cmd+P searches files in the selected directory and existing tabs.
- Ctrl/Cmd+Shift+F opens content search (`%`). `@` searches saved hosts.
- Settings → Keyboard Shortcuts includes installed plugin commands and views.
  Searching this metadata never launches a plugin. Invocation still requires runtime
  consent and executable-plugin approval. These custom bindings are exported in profiles.
- When an installed or updated plugin introduces a shortcut conflict, keep either binding,
  retain both, or open the filtered conflict in Settings. Retained conflicts are highlighted;
  matching commands can run together. Filter with `@is:conflict` and
  `@plugins:plugin-id,another-id`. See the [shortcuts guide](shortcuts.md).
- From a terminal, F1 and Ctrl+Shift+P open Quick Access. Ctrl+K and Ctrl+P retain
  their shell behavior; macOS Command shortcuts remain application shortcuts.

Content search uses a visible local/SSH directory, literal case-insensitive matching,
and no shell. It skips links, hidden/build directories, binary and oversized files,
and stops at 100 matches, 4,000 entries, 8 directory levels, 8 MiB read or 15 seconds
(plus bounded connection setup/close). Remote editor drafts override disk search
results and remain intact when navigating to a matching line.

Appearance starts with compact built-in palette choices and installed plugin themes. One plugin
can supply multiple named palettes; pure theme packs need no Node. Detailed region controls live
under the initially collapsed Customize colors disclosure, grouped into workbench and terminal.
Nested headings, indentation and guide lines distinguish the theme preference from its region
groups and individual colors. A custom main background also derives the global popup, dialog,
border and native-control palette; changing only one region leaves the global palette intact.
Applying a palette changes the base appearance, accent and full color map in one save. Manual
changes show the current custom state; uninstalling a theme provider preserves applied colors.

Appearance includes a full HSV/HEX/RGB picker for the accent and individual backgrounds: main
workspace, activity bar, sidebar, compact title bar, tab bar, editor, panel and status bar. Terminal
background, foreground and cursor have separate controls, and host dialogs offer the same picker
for host markers. Saved overrides are shared across light and dark themes; untouched/reset colors
inherit the active theme. System title bars remain controlled by the OS.

Dragging previews colors without saving; Apply persists once, while Cancel/Escape restores the
latest saved preference. Terminal previews update existing instances and preserve output and
connections. Region resets remove overrides. Custom CSS retains precedence over appearance
settings. Plugin sources and Node setup live in their own Plugins settings category; resetting
ordinary preferences does not delete sources, grants, runtimes or installed plugins.

Open Settings from the bottom of the activity bar or press `Ctrl+,` (`Cmd+,` on
macOS). Search matches Chinese and English labels, descriptions and preference
names across all categories. **Modified only** compares saved preferences with
the current platform defaults. Each item shows its default and numeric range.
Appearance, Workspace, Terminal and Files group related preferences within the same page.
For example, Files separates Browsing, Sorting and Preloading; the preloading switch and child
directory count stay together. Indented navigation jumps to these inline groups. Group names
are searchable in Chinese and English, and changing categories scrolls back to the heading.

Switches and dropdowns save immediately. Numbers save on Enter or blur after
validation; Escape discards an incomplete number. Custom CSS uses an explicit
Apply button, and its draft stays available when changing categories. Pending
writes and failures appear above the category list. Each item has a reset action;
category and full resets require confirmation. Resetting preferences preserves
hosts, credentials, plugins, open tabs and unsaved editor text.

The Profile selector above Settings switches between saved preference snapshots in one action.
Choose **Save as profile…** to name the current applied preferences. Later edits mark the selected
profile as modified; **Update profile** explicitly replaces its snapshot after confirmation.
Manage profiles provides rename, apply, per-profile export and delete. Deleting a snapshot keeps
the current preferences. Names are unique, 1–64 characters, with up to 32 profiles stored locally.

Import and export use native JSON file pickers. Export includes appearance, custom CSS, behavior,
terminal, editor, file view, keyboard preferences and proxy metadata/feature routes. Proxy passwords
remain in the local OS credential store and must be entered again on another computer.
It excludes hosts, passwords, SSH keys,
plugin configuration and credentials, history, open tabs and update records. Import checks the
format/version, size (512 KB maximum), setting names, types and supported ranges, then previews
the profile name and number of changed preferences before Apply. Cancellation changes nothing.
Applying uses the same ordered save and cross-window synchronization as ordinary settings,
including native title bars, live terminal appearance and custom shortcuts. Existing update
records remain intact. An unapplied CSS draft requires confirmation before being discarded;
successful application resets numeric preference and CSS drafts. Imported settings can then be saved as a
named profile. Profiles do not change plugin grants, Node runtimes, SSH sessions or editor text.

Fresh installations use the operating system language and theme, comfortable
13 px interface text, bundled Fira Code at 14 px, a visible status bar and a closed
monitor panel. Windows uses compact window controls; macOS and Linux use the
system title bar. Updates retain previously saved preferences. New fields receive
their defaults without overwriting existing choices.

| Category           | Controls                                                                                                        |
| ------------------ | --------------------------------------------------------------------------------------------------------------- |
| General            | Language, title bar, close to tray, release background WebView, lightweight mode, macOS Dock visibility         |
| Appearance         | Theme, accent, density, UI/monospace font sizes, monospace font, motion                                         |
| Workspace          | Status bar, monitor panel, panel widths, startup restoration, host activation                                   |
| Terminal           | Scrollback, line height, cursor styles/blinking, scrolling, clipboard behavior, renderer, input history         |
| Keyboard shortcuts | Search commands, record bindings, detect conflicts, disable bindings and restore defaults                       |
| Files              | Hidden entries, folders first, sorting, directory preloading, icon themes, transfer tuning and bandwidth limits |
| Text editor        | Word wrap, tab width, spellcheck                                                                                |
| Monitoring         | Local and remote refresh interval                                                                               |
| Network & proxies  | Named HTTP/SOCKS5 proxies, per-feature/plugin routing, credential storage and connection tests                  |
| Updates            | Channel, source, check frequency, download/install progress and release notes                                   |
| Advanced           | Custom CSS, individual/batch storage relocation, full preference reset                                          |

Host-specific proxies and ordered jump hosts live in the host editor's collapsed
**Proxy & jump hosts** section. Port forwards can be managed from the host detail page or the independent forwarding workspace. See
[network and storage](network-storage.md) for route precedence, process-environment
behavior, transfer recovery and SSHFS dependencies.

A single click opens host details by default. **Workspace → Host activation** can change
the single-click and Enter action to connect a terminal or edit the host. Double-click
always connects a terminal. **Connect directly when activating a host** is enabled by
default. A terminal connection uses the saved password or key without an
extra Connect click. SSH still verifies the actual server key before authentication.
Unknown or changed keys, missing credentials and authentication failures open the
connection dialog; trust is never granted automatically. Turn the preference off
to review the connection dialog every time.

Create or edit a host to save a password directly in the operating system credential
store. The saved value is never shown or included in host metadata or settings
profiles. Leave the field blank to retain it, enter a replacement to change it, or
choose **Remove saved password**. Changes apply only on Save; removal can be undone
before saving. If storing a password fails, the draft remains open for retry and
does not create another host.

Workspace restoration restores tabs and layout on the next launch; it does not
automatically reconnect SSH sessions.

## Storage locations

**Advanced → Storage locations** separates the database, installed plugins, plugin data
and chats, managed SSH keys, managed Node runtimes, cache/temporary files, logs and remote
deployment records. Choose an empty or new destination using the native folder picker.
Select multiple categories and **Choose parent folder** to give each its own subfolder.
Use **Reset location** for one category or **Reset selected locations** for a batch.
Resetting schedules a return to the displayed default path and migrates current data by
default. Previous data already at that default is archived separately for recovery;
the database/cache shared root and other categories remain in place. Recovery paths
are listed after the move. See [storage locations](storage.en-us.md)
([简体中文](storage.zh-cn.md)) for details.
Copying existing data is enabled by default; switching it off starts that category empty
and is explicitly shown in the review. Review all source/destination paths before scheduling.

Changes apply on the next full application start, before opening SQLite, log writers or
plugin processes. Fully quit, including tray operation, and reopen after finishing active
work. Closing only the window does not migrate data. Current resources continue to use
their current locations until then. The settings page can cancel a scheduled plan.

Migration checks path conflicts, nesting, available space on recognized local disks and
unsupported links. It copies into separate staging directories, verifies SHA-256 for every
file, and switches all selected locations only after every copy is ready. Originals remain
as recovery copies; Tunnelde does not delete them. An interrupted publication is reused
only when its contents still match the source. A conflicting destination is preserved and
the app continues using original locations, with recovery details in Settings. Correct the
conflict or cancel and select new empty destinations. Individual inventories are bounded to
200,000 entries and 64 directory levels. Other processes should not write application data
while it is being migrated.

`storage.json` is a small bootstrap index in the original app-data directory. It retains
pending changes and previous locations. Storage locations are machine-specific and are
excluded from profiles and settings exports. `TUNNELDE_PLUGINS_DIR`, when set, owns the
plugin location and disables relocation of that category in Settings.

System keychain credentials, external key files, workspaces, transfer destinations and
remote files are not relocated. The database and cache migrate only their named resources,
not unrelated files in their original shared parent. Managed key and runtime references
are adjusted when their copied destination exists. Plugin-owned absolute paths may require
adjustment inside that plugin. User-authored directories are never merged or overwritten.

Hosts, Plugins and Trusted Hosts can move from the sidebar into workspace tabs using
their title drag handles or title menus. Drag a panel to a tab group or workspace edge
to reorder or split it, then drag it back to the activity bar/sidebar or choose Return
to sidebar. Search, expansion and scroll state survive moves. Clicking its activity
icon hides and restores a docked panel while retaining its position, size and live state.
The panel menu also provides Return to sidebar. Each pane can be locked as the destination
for new pages, independently of keyboard focus.

macOS keeps the application and sessions running when its close button is used. **General →
Show in Dock while running in the background** defaults to off. With it off, closing
the window removes its running Dock presence; use the menu-bar tray or launch the app
again to restore it. Restoring returns normal Dock behavior. Minimizing retains the
Dock icon, and Quit exits rather than hiding the window.

**General → Release WebView while in tray** is on by default. After closing to the
tray (automatic on macOS, opt-in on Windows/Linux), the application checkpoints its
workspace and destroys the hidden window. Native SSH sessions, transfers, forwards
and plugin processes continue; restoring from the tray, Dock or a second launch
recreates the window. Terminal screens, scrollback, incomplete input, editor drafts
and caret, file locations and view drafts remain in process memory. These snapshots
are not saved to disk and do not survive Quit or a crash. In-flight view operations
and dialogs defer suspension until they finish. If a checkpoint cannot be created,
the hidden window stays alive to retain the user's work. Turning the setting off
keeps the hidden WebView alive instead.

**General → Lightweight mode** is off by default. Turning it on releases terminal
GPU renderers, suppresses speculative directory preloads and sets local/remote
monitor sampling to at least five seconds. Manual navigation, transfers and SSH
connections continue normally. Existing renderer, preloading and sampling
preferences are preserved and resume when lightweight mode is turned off. Both
background preferences participate in settings export/import and named profiles.

Plugins settings also provide restricted mode, per-plugin approval/revocation, runtime
selection and marketplace sources. `--safe-mode` and `--restricted-mode` force restricted
mode for the current process, including an already-running single instance. Executable
Node/WASM plugins stay stopped while pure theme packs remain available. After an abnormal
exit following plugin execution, startup enters restricted mode and offers recovery.
Installing an update records a planned restart after package verification, so automatic
relaunch does not trigger crash recovery. Explicit restricted mode remains enabled;
failed installations restore the running process's recovery marker.

Terminal settings apply to open terminals without reconnecting. Reducing
scrollback discards lines beyond the new capacity. Smooth scrolling follows the
motion preference; reduced motion disables it. Right click opens a menu by default.
Optional modes paste directly, or copy a selection and clear it before the next
paste. Shift+right click always opens the menu. Copy-on-select is off by default.
Automatic rendering uses WebGL when available and falls back to DOM rendering.
The scrollable preview uses the same terminal settings. With copy-on-select enabled,
user-triggered OSC 52 clipboard writes from mouse-aware terminal tools are supported;
clipboard read requests are blocked. Command-history panes refresh after successful
recording, including when docked elsewhere.

Both the preview and connected terminals use Unicode 15 grapheme widths for Chinese,
emoji sequences and modern terminal tables. A streaming UTF-8 decoder preserves
characters split across SSH packets.

Hidden entries include dotfiles and the Windows hidden attribute for local files.
They still participate in collision checks. `Ctrl+H` / `Cmd+Shift+.` toggles visibility
when the file list has focus. A newly created or renamed hidden item temporarily
reveals itself. Sorting is natural by name, with folders first by default; unknown
modification dates stay last. Preloading warms the parent and up to the configured
number of child directories, with at most two background requests across both
panels. A count of zero warms only the parent; switching preloading off stops new
background requests.

Editor preferences change presentation only: they do not reindent or rewrite
existing content. Monitoring shares requests between views and pauses while
hidden. Turning workspace restoration, status visibility or motion on/off does
not close sessions or discard editor drafts. Remote CPU, memory, network and disk
read/write use timestamped timelines with labeled dashed scales and mouse/keyboard
sample inspection. Missing disk samples are shown as unavailable rather than invented
zero readings.

## Remote process management

The remote process manager supports automatic refresh, CPU/memory, disk I/O,
available TCP/GPU telemetry, searchable user/group details and sortable, paginated
rows. See the [English guide](monitoring.en-us.md) or
[中文说明](monitoring.zh-cn.md) for permissions and metric definitions.
