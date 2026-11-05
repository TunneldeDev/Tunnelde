# Shortcuts

Open **Settings → Keyboard Shortcuts**, use `Ctrl/Cmd+Shift+F12`, or search for
“Keyboard Shortcuts” in the command palette. Search by command name, command id,
context or key. Click a binding to replace it, or **+** to add an alternative;
press the keys and choose Save. Conflicts are highlighted and can be retained.
When installing or updating a plugin introduces a conflict, choose a binding to
keep, retain both, or open the conflict in settings. Use `@is:conflict` and
`@plugins:plugin-id,another-id` to filter related commands. Escape cancels recording.

Changes save automatically and follow settings profiles, including profile
imports and exports. Remove every binding to disable a command, reset an
individual command with its reset button, or choose **Reset all shortcuts**.
File, editor and terminal commands apply within their respective views. Matching
editor and workbench commands may both execute when a conflict is retained. Ordinary text inputs retain editing keys;
Settings and Quick Access remain accessible. Installed plugin commands and views
also appear here, even before their runtime starts, and can have custom bindings.
Input method composition
and AltGr are preserved. Widget navigation such as arrow keys, Tab and Escape
is not remapped by the application shortcut editor.

The following tables show the default bindings.

| Keys                           | Action                                                |
| ------------------------------ | ----------------------------------------------------- |
| `F1`, `Ctrl+K`, `Ctrl+Shift+P` | Quick Access: `>` application and plugin commands     |
| `Ctrl+P`                       | Quick Access: files and open tabs                     |
| `Ctrl+Shift+F`                 | Quick Access: `%` file contents                       |
| `Ctrl+N`                       | New host                                              |
| `Ctrl+B`                       | Show / hide the current sidebar                       |
| `Ctrl+,`                       | Settings                                              |
| `Ctrl+Shift+F12`               | Keyboard Shortcuts settings                           |
| `Ctrl+W`                       | Close the active tab (asks first for unsaved editors) |
| `Ctrl+Shift+W`                 | Close the focused pane when split                     |
| `Ctrl+\`                       | Split the active tab to the right                     |
| `Ctrl+Shift+\`                 | Split the active tab down                             |
| `Ctrl+Tab` / `Ctrl+Shift+Tab`  | Next / previous tab in the focused group              |
| `Ctrl+1` … `Ctrl+9`            | Jump to a tab in the focused group                    |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | Larger, smaller, default monospace size               |
| `Ctrl+X` / `Ctrl+C` / `Ctrl+V` | Cut, copy and paste files in the file panes           |
| `Ctrl+S`                       | Save the open remote file                             |

On macOS, the Command key also works for these actions. In a terminal,
ordinary Control shortcuts stay available to the shell, including `Ctrl+K`,
`Ctrl+N`, `Ctrl+B`, `Ctrl+W`, `Ctrl+\` and Control with a number. Use
`F1` or `Ctrl+Shift+P` for Quick Access, `Ctrl+Shift+N` for a new host,
`Cmd+W` on macOS or `Ctrl+Shift+W` to close the terminal tab/group.
Settings, tab switching and font-size shortcuts remain available in terminals.
Custom workbench Control shortcuts in terminals require Shift unless the
command is Settings, Keyboard Shortcuts, tab switching or font sizing.
Dialogs and input composition take precedence over workspace shortcuts.

In Quick Access, type `>` followed by a command or plugin name (for example
`> command name`) to run it. Type `%` to search contents, or `@` to find a saved host.
File and content searches use the selected directory, with connected file panes
and remote editors offered as roots; the folder button selects a local directory.
File results open the editor at the matching location.

Terminal clipboard:

| Keys                           | Action                                                         |
| ------------------------------ | -------------------------------------------------------------- |
| `Ctrl+V` / `Ctrl+Shift+V`      | Paste on Windows and Linux                                     |
| `Cmd+V` / `Cmd+Shift+V`        | Paste on macOS                                                 |
| `Shift+Insert`                 | Paste on Windows and Linux                                     |
| `Ctrl+C`                       | Windows/Linux: copy selected text; otherwise send an interrupt |
| `Ctrl+Shift+C` / `Ctrl+Insert` | Copy selected text on Windows and Linux                        |
| `Cmd+C`                        | Copy selected text on macOS                                    |

Right-click opens Copy, Paste and Select All. Paste uses the native clipboard
and xterm's bracketed-paste handling so multiline input follows the remote
program's paste mode.

File panes:

| Keys                                | Action                                          |
| ----------------------------------- | ----------------------------------------------- |
| `↑` / `↓`                           | Move the selection                              |
| `Shift+↑` / `Shift+↓`               | Extend the selection                            |
| `Enter`                             | Open a folder, or edit/open the selected file   |
| `Backspace`, `Alt+↑`                | Go to the parent folder                         |
| `Alt+←` / `Alt+→`                   | Back / forward through folder history           |
| `F5`                                | Refresh the current folder                      |
| `Ctrl+H` / `Cmd+H`                  | Toggle hidden entries in the focused file list  |
| `F2`                                | Rename the selected entry in place              |
| `Ctrl+L`                            | Focus and select the current panel's path       |
| `Enter` / `Esc` in a filename input | Commit / cancel inline creation or rename       |
| `Delete`                            | Delete the selected entries                     |
| `Ctrl+A`                            | Select every entry                              |
| `Home` / `End`                      | Select the first / last entry                   |
| `Ctrl+N` / `Ctrl+Shift+N`           | Create a file / folder in the focused file pane |
| `Space`                             | Preview the selected local or remote file       |
| `Esc`                               | Clear the selection                             |

With the mouse, `Ctrl/Cmd+click` adds or removes one row and `Shift+click` selects a range. Delete,
transfer, cut, copy, paste and drag all act on the whole selection.

Window gestures:

- Middle-click a tab closes it.
- Drag the background transfer window's title to move it and any edge or corner to
  resize it. Focus its title and use arrow keys to move; focus its bottom-right
  handle and use arrow keys to resize. Shift changes the adjustment to one pixel.
  Escape cancels an active drag; otherwise it closes the transfer list. Double-click
  the title or use Reset layout to restore its default placement.
- Pages and plugin details open in one reusable italic preview tab per pane. Selecting a
  different item replaces that preview. Selecting the same item again or double-clicking
  its tab keeps it open. Interacting with page controls or dragging the tab also keeps it.
- Use a tab's context menu to **Keep open** or separately **Pin / Unpin**. The `tab.keepOpen`
  command is available in Quick Access and can be assigned a shortcut.
- Drag a tab onto another pane's strip to move it, or onto a window edge to
  create a pane on that side.
- Right-click a tab, host or file for its context menu.
- Settings → General switches between system and compact title bars. In compact
  mode, drag the grip or empty tab-strip space to move the window; double-click
  to maximize or restore. macOS retains its native window buttons.
- Drag a file or folder between the two file panes to copy it; dropping it in
  the same pane renames or moves it. Either pane can show this computer or any
  open session.
- Drag editor group dividers to resize, or focus a divider and use the arrow
  keys. Double-click or press Home to restore an equal split.
