# Settings

Open Settings from the bottom of the activity bar or press `Ctrl+,` (`Cmd+,` on
macOS). Search matches Chinese and English labels, descriptions and preference
names across all categories. **Modified only** compares saved preferences with
the current platform defaults. Each item shows its default and numeric range.

Switches and dropdowns save immediately. Numbers save on Enter or blur after
validation; Escape discards an incomplete number. Custom CSS uses an explicit
Apply button, and its draft stays available when changing categories. Pending
writes and failures appear above the category list. Each item has a reset action;
category and full resets require confirmation. Resetting preferences preserves
hosts, credentials, plugins, open tabs and unsaved editor text.

Fresh installations use the operating system language and theme, comfortable
13 px interface text, bundled Fira Code at 14 px, a visible status bar and a closed
monitor panel. Windows uses compact window controls; macOS and Linux use the
system title bar. Updates retain previously saved preferences. New fields receive
their defaults without overwriting existing choices.

| Category    | Controls                                                                                                |
| ----------- | ------------------------------------------------------------------------------------------------------- |
| General     | Language, window title bar, close to tray where supported                                               |
| Appearance  | Theme, accent, density, UI/monospace font sizes, monospace font, motion                                 |
| Workspace   | Status bar, monitor panel, panel widths, startup restoration, host activation                           |
| Terminal    | Scrollback, line height, cursor styles/blinking, scrolling, clipboard behavior, renderer, input history |
| Files       | Hidden entries, folders first, sort field/direction, directory preloading                               |
| Text editor | Word wrap, tab width, spellcheck                                                                        |
| Monitoring  | Local and remote refresh interval                                                                       |
| Updates     | Automatic checks and access to the update page                                                          |
| Advanced    | Custom CSS, data/log folders, full preference reset                                                     |

Host rows select on a single click or Space. Double click or Enter runs the chosen
activation action: open a terminal (default), show details, or edit the host.
Workspace restoration restores tabs and layout on the next launch; it does not
automatically reconnect SSH sessions.

Terminal settings apply to open terminals without reconnecting. Reducing
scrollback discards lines beyond the new capacity. Smooth scrolling follows the
motion preference; reduced motion disables it. Right click opens a menu by default.
Optional modes paste directly, or copy a selection and clear it before the next
paste. Shift+right click always opens the menu. Copy-on-select is off by default.
Automatic rendering uses WebGL when available and falls back to DOM rendering.

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
