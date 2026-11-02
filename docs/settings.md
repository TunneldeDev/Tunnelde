# Settings

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
terminal, editor, file view and keyboard preferences. It excludes hosts, passwords, SSH keys,
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

| Category           | Controls                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------- |
| General            | Language, window title bar, close to tray where supported                                               |
| Appearance         | Theme, accent, density, UI/monospace font sizes, monospace font, motion                                 |
| Workspace          | Status bar, monitor panel, panel widths, startup restoration, host activation                           |
| Terminal           | Scrollback, line height, cursor styles/blinking, scrolling, clipboard behavior, renderer, input history |
| Keyboard shortcuts | Search commands, record bindings, detect conflicts, disable bindings and restore defaults               |
| Files              | Hidden entries, folders first, sort field/direction, directory preloading                               |
| Text editor        | Word wrap, tab width, spellcheck                                                                        |
| Monitoring         | Local and remote refresh interval                                                                       |
| Updates            | Automatic checks and access to the update page                                                          |
| Advanced           | Custom CSS, data/log folders, full preference reset                                                     |

Host rows select on a single click or Space. Double click or Enter runs the chosen
activation action: open a terminal (default), show details, or edit the host.
Workspace restoration restores tabs and layout on the next launch; it does not
automatically reconnect SSH sessions.

Hosts, Plugins and Trusted Hosts can move from the sidebar into workspace tabs using
their title drag handles or title menus. Drag a panel to a tab group or workspace edge
to reorder or split it, then drag it back to the activity bar/sidebar or choose Return
to sidebar. Search, expansion and scroll state survive moves. Clicking its activity
icon focuses an already-docked panel; closing its tab returns it to the sidebar.

Plugins settings also provide restricted mode, per-plugin approval/revocation, runtime
selection and marketplace sources. `--safe-mode` and `--restricted-mode` force restricted
mode for the current process, including an already-running single instance. Executable
Node/WASM plugins stay stopped while pure theme packs remain available. After an abnormal
exit following plugin execution, startup enters restricted mode and offers recovery.

Terminal settings apply to open terminals without reconnecting. Reducing
scrollback discards lines beyond the new capacity. Smooth scrolling follows the
motion preference; reduced motion disables it. Right click opens a menu by default.
Optional modes paste directly, or copy a selection and clear it before the next
paste. Shift+right click always opens the menu. Copy-on-select is off by default.
Automatic rendering uses WebGL when available and falls back to DOM rendering.

Both the preview and connected terminals use Unicode 15 grapheme widths for Chinese,
emoji sequences and modern terminal tables. A streaming UTF-8 decoder preserves
characters split across SSH packets.

Hidden entries include dotfiles and the Windows hidden attribute for local files.
They still participate in collision checks. `Ctrl+H` / `Cmd+H` toggles visibility
when the file list has focus. A newly created or renamed hidden item temporarily
reveals itself. Sorting is natural by name, with folders first by default; unknown
modification dates stay last. Preloading warms the parent and up to the configured
number of child directories, with at most two background requests across both
panels. A count of zero warms only the parent; switching preloading off stops new
background requests.

Editor preferences change presentation only: they do not reindent or rewrite
existing content. Monitoring shares requests between views and pauses while
hidden. Turning workspace restoration, status visibility or motion on/off does
not close sessions or discard editor drafts.
